/**
 * Seat holds on Cinépolis, exactly as the site does them:
 *   UserSessionId(cinemaVistaId)  [member]   -> user_session_id (the order id)
 *   Tickets(+userSessionId)       [public]   -> ticket options for the order
 *   Order(orderData)              [member]   -> seats held, totals in cents
 *   CancelOrder(order_session_id = user_session_id)  /v1/carts  -> release
 *   ExtendOrder(user_session_id)                     /v1/carts  -> keep alive
 *
 * One hold at a time. Holds are persisted (0600) so a restart can release an
 * orphan. Order handles never leave this module; tools see an opaque holdId.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Cinema, Showtime } from "../domain.js";
import { CinesError } from "../errors.js";
import { buildOrderData, chooseTicket, newOrderSessionId, type RawTicket } from "../order/orderData.js";
import type { TicketType } from "../provider.js";
import type { Seat, SeatLayout } from "../seats.js";
import type { GraphQLClient } from "./client.js";
import { CANCEL_ORDER, EXTEND_ORDER, ORDER, TICKETS, USER_SESSION_ID } from "./queries.js";
import { parse, TicketsSchema } from "./schemas.js";

export interface Hold {
  holdId: string;
  createdAt: string;
  expiresAt: string;
  status: "held" | "released" | "expired" | "purchasing" | "purchased" | "failed";
  cinemaId: string;
  cinemaName: string;
  showtimeId: string;
  date: string;
  time: string;
  language: string;
  format: string;
  seats: string[];
  ticketType: string;
  unitMxn: number;
  chargesMxn: number;
  subtotalMxn: number;
  totalMxn: number;
  /** Private handles (never returned by tools). */
  priv: { orderId: string; orderSessionId: string; cinemaVistaId: string; sessionId: string };
}

export function publicHold(h: Hold) {
  const { priv: _priv, ...rest } = h;
  return rest;
}

export interface HoldRequest {
  cinema: Cinema;
  showtime: Showtime;
  movie: { name: string; image?: string };
  layout: SeatLayout;
  seats: Seat[];
  ticketType?: string;
  defaultTicketType: string;
  accessToken: string;
}

const OrderResp = z.object({
  order: z.object({
    order: z.object({ cinemaVistaId: z.string().nullish(), tickets: z.object({ orderId: z.string() }), total: z.number(), charges: z.number().nullish(), subtotal: z.number().nullish() }).nullable(),
  }),
});
const CancelResp = z.object({
  CancelOrder: z.object({ cancelOrderResult: z.object({ result: z.number().nullish(), order_not_found: z.boolean().nullish(), error_description: z.string().nullish() }) }),
});

export interface HoldServiceOptions {
  client: GraphQLClient;
  stateFile: string;
  /** Hold lifetime before we auto-release (default 9 min; the site's own limit is ~10). */
  ttlMs?: number;
  /** Refuse holds above this total (MXN). */
  capMxn?: number;
  now?: () => number;
  log?: (m: string) => void;
}

export class HoldService {
  private holds: Hold[] = [];
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly log: (m: string) => void;

  constructor(private readonly o: HoldServiceOptions) {
    this.now = o.now ?? Date.now;
    this.ttl = o.ttlMs ?? 9 * 60_000;
    this.log = o.log ?? ((m) => console.error(`[holds] ${m}`));
    this.load();
  }

  private load(): void {
    if (!existsSync(this.o.stateFile)) return;
    try {
      this.holds = JSON.parse(readFileSync(this.o.stateFile, "utf8")) as Hold[];
    } catch {
      this.holds = [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.o.stateFile), { recursive: true, mode: 0o700 });
    writeFileSync(this.o.stateFile, JSON.stringify(this.holds.slice(-20), null, 1), { mode: 0o600 });
  }

  /** Holds are shared with the CLI through the state file; re-read before deciding. */
  private refresh(): void {
    this.load();
  }

  active(): Hold | undefined {
    this.refresh();
    const h = this.holds.find((x) => x.status === "held" || x.status === "purchasing");
    if (h && h.status === "held" && Date.parse(h.expiresAt) <= this.now()) {
      h.status = "expired";
      this.save();
      return undefined;
    }
    return h;
  }

  get(holdId: string): Hold | undefined {
    this.refresh();
    return this.holds.find((h) => h.holdId === holdId);
  }

  update(h: Hold): void {
    const i = this.holds.findIndex((x) => x.holdId === h.holdId);
    if (i >= 0) this.holds[i] = h;
    else this.holds.push(h);
    this.save();
    if (h.status !== "held") this.clearTimer();
  }

  /** Release holds left over from a previous process (call at startup). */
  async releaseOrphans(): Promise<number> {
    let n = 0;
    for (const h of this.holds.filter((x) => x.status === "held")) {
      await this.cancelRemote(h).catch((e: unknown) => this.log(`orphan release failed: ${(e as Error).message}`));
      h.status = "released";
      n++;
    }
    if (n) this.save();
    return n;
  }

  async hold(req: HoldRequest): Promise<Hold> {
    const current = this.active();
    if (current) throw new CinesError("CINES_BAD_REQUEST", `Ya hay asientos apartados (${current.seats.join(", ")} a las ${current.time}). Libéralos o cómpralos primero.`);
    const c = this.o.client;
    const userSessionId = await c.call<{ user_session_id: string }>(USER_SESSION_ID, { cinemaId: req.cinema.vistaId }, { accessToken: req.accessToken });
    const usid = userSessionId.user_session_id;
    if (!usid) throw new CinesError("CINES_SCHEMA_CHANGED", "Cinépolis no devolvió una sesión de compra.");
    // The site calls Tickets WITH userSessionId right before Order (Vista prepares
    // the order session there). Do the same; its list only has Club/account
    // tickets, which we never pick automatically, so it is used for nothing else.
    await c
      .call(TICKETS, { countryId: c.countryId, cinemaVistaId: req.cinema.vistaId, sessionId: req.showtime.sessionId, userSessionId: usid }, { accessToken: req.accessToken, noDedupe: true })
      .catch((e: unknown) => this.log(`member tickets step failed: ${(e as Error).message}`));
    // General ticket types (and the options sent in Order) come from the public call.
    const tData = parse(
      TicketsSchema,
      await c.call(TICKETS, { cinemaVistaId: req.cinema.vistaId, sessionId: req.showtime.sessionId, countryId: c.countryId }, { noDedupe: true }),
      "Tickets",
    );
    const area = tData.tickets.find((a) => a.areaCategoryCode === req.seats[0]?.areaCode) ?? tData.tickets[0];
    if (!area) throw new CinesError("CINES_NOT_FOUND", "No hay boletos disponibles para esta función.");
    const raw: RawTicket[] = area.tickets;
    const types: TicketType[] = raw.map((t) => ({
      id: t.id,
      code: t.ticketTypeCode,
      description: t.description,
      priceMxn: t.priceInCents / 100,
      bookingFeeMxn: (t.bookingFee ?? 0) / 100,
      areaCategoryCode: area.areaCategoryCode,
      maxPerOrder: t.quantityAvailablePerOrder ?? undefined,
      isPackage: t.isPackageTicket ?? false,
    }));
    const chosen = chooseTicket(types, req.ticketType, req.defaultTicketType);
    if (!chosen) throw new CinesError("CINES_NOT_FOUND", `No encontré el tipo de boleto "${req.ticketType ?? req.defaultTicketType}". Opciones: ${types.map((t) => t.description).join(", ")}`);
    if (chosen.maxPerOrder !== undefined && req.seats.length > chosen.maxPerOrder) {
      throw new CinesError("CINES_BAD_REQUEST", `"${chosen.description}" permite máximo ${chosen.maxPerOrder} por compra.`);
    }
    const estimate = (chosen.priceMxn + chosen.bookingFeeMxn) * req.seats.length;
    const cap = this.o.capMxn ?? 1000;
    if (estimate > cap) throw new CinesError("CINES_LIMIT_EXCEEDED", `El total estimado ($${estimate.toFixed(2)}) supera el límite de $${cap}.`);

    const orderSessionId = newOrderSessionId(this.now());
    const orderData = buildOrderData({
      orderSessionId,
      userSessionId: usid,
      countryId: c.countryId,
      cinema: req.cinema,
      showtime: req.showtime,
      movie: req.movie,
      layout: req.layout,
      seats: req.seats,
      tickets: raw,
      selectedTicketId: chosen.id,
    });
    const res = parse(OrderResp, await c.call(ORDER, { orderData }, { accessToken: req.accessToken, noDedupe: true }), "Order").order.order;
    if (!res) throw new CinesError("CINES_UNAVAILABLE", "Cinépolis no pudo apartar los asientos (quizá alguien los tomó).", { retryable: true });
    const h: Hold = {
      holdId: `hold_${randomBytes(6).toString("hex")}`,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + this.ttl).toISOString(),
      status: "held",
      cinemaId: req.cinema.id,
      cinemaName: req.cinema.name,
      showtimeId: req.showtime.id,
      date: req.showtime.date,
      time: req.showtime.time,
      language: req.showtime.language,
      format: req.showtime.experience ?? req.showtime.format,
      seats: req.seats.map((s) => s.label),
      ticketType: chosen.description,
      unitMxn: chosen.priceMxn,
      chargesMxn: (res.charges ?? 0) / 100,
      subtotalMxn: (res.subtotal ?? 0) / 100,
      totalMxn: res.total / 100,
      priv: { orderId: res.tickets.orderId || usid, orderSessionId, cinemaVistaId: req.cinema.vistaId, sessionId: req.showtime.sessionId },
    };
    this.holds.push(h);
    this.save();
    if (h.totalMxn > cap) {
      await this.release(h.holdId).catch(() => undefined);
      throw new CinesError("CINES_LIMIT_EXCEEDED", `El total ($${h.totalMxn.toFixed(2)}) supera el límite de $${cap}; liberé los asientos.`);
    }
    this.arm(h);
    this.log(`held ${h.seats.length} seat(s) ${h.holdId} total ${h.totalMxn}`);
    return h;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(h: Hold): void {
    this.clearTimer();
    const ms = Math.max(0, Date.parse(h.expiresAt) - this.now());
    this.timer = setTimeout(() => {
      if (h.status === "held") void this.release(h.holdId, "expired").catch((e: unknown) => this.log(`auto-release failed: ${(e as Error).message}`));
    }, ms);
    this.timer.unref?.();
  }

  private async cancelRemote(h: Hold): Promise<void> {
    const r = parse(
      CancelResp,
      await this.o.client.call(CANCEL_ORDER, { input: { country_id: this.o.client.countryId, order_session_id: h.priv.orderId } }, { noDedupe: true }),
      "CancelOrder",
    ).CancelOrder.cancelOrderResult;
    if (r.error_description && !r.order_not_found) throw new CinesError("CINES_UNAVAILABLE", `Cinépolis no liberó los asientos: ${r.error_description}`, { retryable: true });
  }

  async release(holdId?: string, why: "released" | "expired" = "released"): Promise<Hold | undefined> {
    const h = holdId ? this.get(holdId) : this.active();
    if (!h) return undefined;
    if (h.status === "purchasing") throw new CinesError("CINES_BAD_REQUEST", "Hay un pago en curso; no puedo liberar estos asientos ahora.");
    if (h.status !== "held") return h;
    await this.cancelRemote(h);
    h.status = why;
    this.update(h);
    this.log(`${why} ${h.holdId}`);
    return h;
  }

  /** Keep the Cinépolis order alive while the user is paying (local status is "purchasing"). */
  async extendRemote(holdId: string): Promise<boolean> {
    const h = this.get(holdId);
    if (!h) return false;
    const r = await this.o.client
      .call<{ ExtendOrder: { extendOrderResult: { status: string } } }>(EXTEND_ORDER, { user_session_id: h.priv.orderId }, { noDedupe: true })
      .catch(() => undefined);
    return String(r?.ExtendOrder.extendOrderResult.status) === "true";
  }

  /** Release after a payment that provably did not complete (never called when the outcome is unknown). */
  async releaseUnpaid(holdId: string): Promise<void> {
    const h = this.get(holdId);
    if (!h || h.status === "purchased" || h.status === "released") return;
    await this.cancelRemote(h);
    h.status = "released";
    this.update(h);
    this.log(`released after unpaid attempt ${h.holdId}`);
  }

  /** Ask Cinépolis for more time (the site does this when its countdown runs out). */
  async extend(holdId: string, extraMs = 5 * 60_000): Promise<Hold> {
    const h = this.get(holdId);
    if (!h || h.status !== "held") throw new CinesError("CINES_HOLD_EXPIRED", "Esos asientos ya no están apartados.");
    const r = (await this.o.client.call<{ ExtendOrder: { extendOrderResult: { status: string } } }>(EXTEND_ORDER, { user_session_id: h.priv.orderId }, { noDedupe: true }))
      .ExtendOrder.extendOrderResult.status;
    if (String(r) !== "true") throw new CinesError("CINES_HOLD_EXPIRED", "Cinépolis no extendió el tiempo de los asientos.");
    h.expiresAt = new Date(Math.max(Date.parse(h.expiresAt), this.now()) + extraMs).toISOString();
    this.update(h);
    this.arm(h);
    return h;
  }
}
