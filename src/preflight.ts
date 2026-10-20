/**
 * Read-only pre-flight for the first real purchase:
 *   cinesctl preflight <showtimeId> [tickets]
 * Nothing is held, armed or paid. Browser checks open the bot's headed Chrome.
 */
import { existsSync } from "node:fs";
import type { GraphQLClient } from "./cinepolis/client.js";
import type { HoldService } from "./cinepolis/orders.js";
import type { CinepolisProvider } from "./cinepolis/provider.js";
import { CANCEL_ORDER, ORDER_DISPATCHER, PROFILE } from "./cinepolis/queries.js";
import { CinesError, toErrorShape } from "./errors.js";
import type { PaymentArm } from "./order/arm.js";
import { approvalRequired, capMxn, type PurchaseLedger } from "./order/purchase.js";
import type { Profile } from "./profile.js";
import { seatExperience } from "./seatTools.js";
import type { SessionManager } from "./session/session.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Informational checks never block. */
  info?: boolean;
}

export interface PreflightDeps {
  provider: CinepolisProvider;
  client: GraphQLClient;
  profile: Profile;
  holds: HoldService;
  ledger: PurchaseLedger;
  arm: PaymentArm;
  session: SessionManager;
  paypalLoggedIn?: () => Promise<boolean>;
  /** Saved cards in the user's DEUNA wallet (read-only browser check). */
  savedCards?: () => Promise<{ lastFour: string; isDefault?: boolean; expired?: boolean }[]>;
  serverUrl?: string;
  env?: NodeJS.ProcessEnv;
  chromePath?: string;
  fetchLocal?: typeof fetch;
}

async function check(name: string, f: () => Promise<string>, info = false): Promise<Check> {
  try {
    return { name, ok: true, detail: await f(), info };
  } catch (e) {
    const { error } = toErrorShape(e);
    return { name, ok: false, detail: error.message, info };
  }
}

const must = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};

export async function runPreflight(showtimeId: string, tickets: number, d: PreflightDeps): Promise<Check[]> {
  const env = d.env ?? process.env;
  const out: Check[] = [];
  out.push(
    await check("config", async () => {
      const missing = ["CINES_LOGIN_EMAIL", "CINES_BUYER_NAME", "CINES_IMAP_USER"].filter((k) => !env[k]);
      must(!missing.length, `faltan en cines.env: ${missing.join(", ")}`);
      return "cines.env completo";
    }),
  );
  out.push(
    await check("chrome", async () => {
      const p = d.chromePath ?? "/Applications/Google Chrome.app";
      must(existsSync(p), `no encontré ${p}`);
      return "Google Chrome instalado";
    }),
  );
  if (d.serverUrl) {
    out.push(
      await check("server", async () => {
        const r = await (d.fetchLocal ?? fetch)(d.serverUrl!.replace(/\/mcp$/, "/healthz"), { signal: AbortSignal.timeout(5000) });
        must(r.ok, `HTTP ${r.status}`);
        return "cines-mx-mcp responde";
      }),
    );
  }
  // Showtime, seats and price (public).
  out.push(
    await check("showtime", async () => {
      const m = /^(\d+)-(\d+)$/.exec(showtimeId);
      must(m, `showtimeId inválido "${showtimeId}"`);
      const cinemas = await d.provider.getCinemas(d.profile.cinemas.map((c) => c.id));
      const cinema = cinemas.find((c) => c.vistaId === m![1]);
      must(cinema, `el cine ${m![1]} no está en tu perfil`);
      const st = (await d.provider.getShowtimesByCinema(cinema!.id)).find((s) => s.sessionId === m![2]);
      must(st, "no encontré la función (¿ya pasó?)");
      must(Date.parse(st!.startsAt) > Date.now() + 30 * 60_000, "la función empieza en menos de 30 min");
      const layout = await d.provider.getSeatLayout({ cinemaVistaId: m![1]!, sessionId: m![2]!, experience: seatExperience(cinema, st) });
      must(layout.counts.available >= tickets, `solo ${layout.counts.available} asientos libres`);
      const types = await d.provider.getTickets({ cinemaVistaId: m![1]!, sessionId: m![2]! });
      const def = types.find((t) => t.description.toLowerCase() === d.profile.preferences.defaultTicketType.toLowerCase());
      must(def, `no hay "${d.profile.preferences.defaultTicketType}"`);
      const total = Math.round((def!.priceMxn + def!.bookingFeeMxn) * tickets * 100) / 100;
      const cap = capMxn(env);
      must(total <= cap, `total estimado $${total} > límite $${cap}`);
      return `${cinema!.name} ${st!.date} ${st!.time} ${st!.language} · ${layout.counts.available} libres · ${tickets} × ${def!.description} ≈ $${total} MXN (límite $${cap})`;
    }),
  );
  out.push(
    await check("release-path", async () => {
      const r = await d.client.call<{ CancelOrder: { cancelOrderResult: { order_not_found?: boolean | null } } }>(
        CANCEL_ORDER,
        { input: { country_id: d.client.countryId, order_session_id: "0".repeat(32) } },
        { noDedupe: true },
      );
      must(r.CancelOrder.cancelOrderResult.order_not_found === true, "respuesta inesperada de CancelOrder");
      return "CancelOrder (/v1/carts) responde";
    }),
  );
  out.push(
    await check("booking-check", async () => {
      try {
        await d.client.call(ORDER_DISPATCHER, { orderSessionId: `${"0".repeat(36)}-0`, countryId: d.client.countryId }, { noDedupe: true });
      } catch (e) {
        // With a dummy id Cinépolis answers a business error ("no pudimos completar tu pedido"): reachable.
        if (!(e instanceof CinesError && e.code === "CINES_BAD_REQUEST")) throw e;
      }
      return "OrderDispatcher (/v1/purchase) responde";
    }),
  );
  // Member session (may open the bot's Chrome briefly).
  out.push(
    await check("session", async () => {
      await d.session.keepAlive();
      const token = await d.session.getAccessToken({ allowLogin: false });
      const p = await d.client.call<{ member: { levelName?: string | null } | null }>(PROFILE, { countryId: d.client.countryId }, { accessToken: token });
      must(p.member, "Cinépolis no devolvió tu perfil");
      const s = d.session.status();
      return `sesión válida hasta ${s.expiresAt} · refresh ${s.hasRefreshToken ? "sí" : "no"} · nivel ${p.member!.levelName ?? "?"}`;
    }),
  );
  if (d.savedCards) {
    const c = await check("card", async () => {
        const cards = await d.savedCards!();
        const usable = cards.filter((c) => !c.expired);
        must(usable.length, cards.length ? "todas tus tarjetas guardadas están vencidas" : "no hay tarjetas guardadas en tu cuenta de Cinépolis");
        const want = env.CINES_CARD_LAST4;
        if (want) must(usable.some((c) => c.lastFour === want), `CINES_CARD_LAST4=${want} no está entre tus tarjetas vigentes`);
        const list = cards.map((c) => `*${c.lastFour}${c.isDefault ? " (predeterminada)" : ""}${c.expired ? " (vencida)" : ""}`).join(", ");
        const use = want ?? (usable.find((c) => c.isDefault) ?? usable[0])!.lastFour;
        return `tarjetas guardadas: ${list} · se usará *${use}${usable.length > 1 && !want ? " (fija otra con CINES_CARD_LAST4 o cardLast4)" : ""}`;
    });
    // payment_methods needs an order session with an active hold: informational, not a failure.
    out.push(c.ok || !/se verifica al apartar/.test(c.detail) ? c : { ...c, ok: true, info: true });
  }
  if (d.paypalLoggedIn) {
    // Not required: the PayPal window opens headed at the Mac during checkout and the user can log in there.
    const logged = await d.paypalLoggedIn!().catch(() => false);
    out.push({ name: "paypal", ok: true, info: true, detail: logged ? "PayPal con sesión en el perfil del bot" : "sin sesión de PayPal detectada: tendrás que iniciar sesión en la ventana de PayPal durante el pago" });
  }
  out.push(
    await check("state", async () => {
      const h = d.holds.active();
      must(!h, `hay asientos apartados (${h?.seats.join(", ")}); libéralos: bin/cinesctl release-hold`);
      must(!d.ledger.inFlight(), "hay un pago marcado en curso");
      return "sin apartados ni pagos en curso";
    }),
  );
  const a = d.arm.status();
  out.push({ name: "arm", ok: true, info: true, detail: a.armed ? `ARMADO (${a.minutesLeft} min restantes)` : "desarmado (normal hasta el paso final)" });
  out.push({ name: "approval", ok: true, info: true, detail: approvalRequired(d.ledger) ? `se pedirá ✅ (compras exitosas: ${d.ledger.successes()})` : "sin ✅ (ya hubo 3 compras)" });
  return out;
}
