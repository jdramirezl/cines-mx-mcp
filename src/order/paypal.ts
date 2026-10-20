/**
 * PayPal payment driver (Cinépolis -> DEUNA -> PayPal), deterministic.
 *
 *   1. paypalWalletCheckout (member API) for the held order -> DEUNA order token.
 *   2. Open DEUNA's checkout for that token in the bot's HEADED Chrome, so the
 *      user at the server Mac sees it. DEUNA opens the PayPal popup; the user
 *      logs in / passes any 2FA or new-device check and approves.
 *   3. Meanwhile poll OrderDispatcher (public, /v1/purchase) for the booking,
 *      and extend the Cinépolis order so the seats are not lost while waiting.
 *   4. Booking found -> screenshot -> done.
 *      No booking by the deadline / window closed / unexpected page ->
 *      one final check; if still nothing and nothing in progress, release the
 *      hold and fail (nothing charged). If an order is in an unknown state,
 *      do NOT release; report unknown so the user checks e-mail. Never retries.
 *
 * Steps 2-4 against the live DEUNA page are verified on the first real
 * purchase with the user watching.
 */
import type { HoldService } from "../cinepolis/orders.js";
import type { GraphQLClient } from "../cinepolis/client.js";
import { ORDER_DISPATCHER, PAYPAL_WALLET_CHECKOUT } from "../cinepolis/queries.js";
import { CinesError } from "../errors.js";
import type { PaymentContext, PaymentDriver, PaymentMethod, PaymentResult } from "./purchase.js";

export interface PaymentPage {
  isClosed(): boolean;
  text(): Promise<string>;
  screenshot(name: string): Promise<string | undefined>;
}

export interface PaymentUi {
  /** Open `url` in the bot's headed Chrome and run `fn` while the window is open. */
  run<T>(url: string, fn: (page: PaymentPage) => Promise<T>): Promise<T>;
}

export interface Buyer {
  email: string;
  firstName: string;
  lastName: string;
}

export interface Booking {
  bookingNumber?: string;
  transactionNumber?: string;
  status?: string;
}

export interface PaypalDriverDeps {
  client: GraphQLClient;
  holds: HoldService;
  accessToken: () => Promise<string>;
  buyer: () => Promise<Buyer>;
  ui: PaymentUi;
  /** How long to wait for the user at the screen (default 15 min, CINES_PAYPAL_WAIT_MIN). */
  waitMs?: number;
  pollMs?: number;
  extendEveryMs?: number;
  /** How long the DEUNA page has to show payment content (default 60 s). */
  pageReadyMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEUNA_CHECKOUT = "https://pay.deuna.io/now/";

type Outcome =
  | { kind: "paid"; booking: Booking; shot?: string }
  | { kind: "timeout" | "closed" | "unexpected"; shot?: string };

export class PaypalDriver implements PaymentDriver {
  readonly name = "paypal";
  constructor(private readonly d: PaypalDriverDeps) {}

  supports(method: PaymentMethod): boolean {
    return method === "paypal";
  }

  /** Booking for a Cinépolis order session, if the purchase completed. Never throws. */
  async booking(orderSessionId: string): Promise<Booking | undefined> {
    try {
      const r = await this.d.client.call<{ orderDispatcher: null | { status?: string | null; booking_id?: string | null; transaction?: { booking_number?: string | null; trans_number?: string | null } | null } }>(
        ORDER_DISPATCHER,
        { orderSessionId, countryId: this.d.client.countryId },
        { noDedupe: true },
      );
      const o = r.orderDispatcher;
      if (!o) return undefined;
      const bookingNumber = o.transaction?.booking_number || undefined;
      return { bookingNumber: bookingNumber ?? (o.booking_id || undefined), transactionNumber: o.transaction?.trans_number || undefined, status: o.status ?? undefined };
    } catch {
      return undefined;
    }
  }

  async pay(ctx: PaymentContext): Promise<PaymentResult> {
    const { hold, log } = ctx;
    const now = this.d.now ?? Date.now;
    const sleep = this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const waitMs = this.d.waitMs ?? 15 * 60_000;
    const pollMs = this.d.pollMs ?? 5000;
    const extendEvery = this.d.extendEveryMs ?? 4 * 60_000;
    const readyMs = this.d.pageReadyMs ?? 60_000;
    const unpaid = async (why: string): Promise<never> => {
      await this.d.holds.releaseUnpaid(hold.holdId).catch((e: unknown) => log(`release failed: ${(e as Error).message}`));
      throw new CinesError("CINES_PAYMENT_FAILED", `${why} No se cobró nada y liberé los asientos.`);
    };

    // 1. DEUNA order token for the held order.
    let orderToken: string;
    try {
      const buyer = await this.d.buyer();
      const r = await this.d.client.call<{ paypalWalletCheckout: { orderToken: { order_token: string } } }>(
        PAYPAL_WALLET_CHECKOUT,
        {
          country_id: this.d.client.countryId,
          order_session_id: hold.priv.orderSessionId,
          user_session_id: hold.priv.orderId,
          email: buyer.email,
          first_name: buyer.firstName,
          last_name: buyer.lastName,
          format: hold.format === "IMAX" || hold.format === "4DX" || hold.format === "XE" || hold.format === "SCREENX" ? hold.format : "2D",
          isPartial: false,
        },
        { accessToken: await this.d.accessToken(), noDedupe: true },
      );
      orderToken = r.paypalWalletCheckout.orderToken.order_token;
      if (!orderToken) throw new Error("empty order token");
    } catch (e) {
      return unpaid(`No pude iniciar el pago con PayPal (${(e as Error).message}).`);
    }
    log("deuna checkout token obtained");

    // 2-3. Headed checkout; wait for the user while polling for the booking.
    let outcome: Outcome;
    try {
      outcome = await this.d.ui.run(`${DEUNA_CHECKOUT}${encodeURIComponent(orderToken)}`, async (page): Promise<Outcome> => {
        const start = now();
        let lastExtend = start;
        let ready = false;
        while (now() - start < waitMs) {
          const b = await this.booking(hold.priv.orderSessionId);
          if (b?.bookingNumber) {
            await sleep(3000); // let the confirmation render
            return { kind: "paid", booking: b, shot: await page.screenshot("confirmation") };
          }
          if (page.isClosed()) return { kind: "closed" };
          if (!ready) {
            ready = /paypal|deuna|pagar|pago|redirig/i.test(await page.text().catch(() => ""));
            if (!ready && now() - start > readyMs) return { kind: "unexpected", shot: await page.screenshot("unexpected") };
          }
          if (now() - lastExtend >= extendEvery) {
            lastExtend = now();
            const ok = await this.d.holds.extendRemote(hold.holdId);
            log(`extend order: ${ok ? "ok" : "refused"}`);
          }
          await sleep(pollMs);
        }
        return { kind: "timeout", shot: await page.screenshot("timeout") };
      });
    } catch (e) {
      log(`checkout window error: ${(e as Error).message}`);
      outcome = { kind: "unexpected" };
    }

    if (outcome.kind === "paid") {
      return { bookingNumber: outcome.booking.bookingNumber!, transactionNumber: outcome.booking.transactionNumber, screenshotPath: outcome.shot };
    }
    // 4. Final check before deciding nothing happened.
    await sleep(pollMs);
    const last = await this.booking(hold.priv.orderSessionId);
    if (last?.bookingNumber) return { bookingNumber: last.bookingNumber, transactionNumber: last.transactionNumber, screenshotPath: outcome.shot };
    if (last?.status) {
      throw new CinesError("CINES_UNAVAILABLE", `El pago quedó en estado "${last.status}". No libero los asientos ni reintento; revisa tu correo de Cinépolis/PayPal.`, { retryable: false });
    }
    const why =
      outcome.kind === "timeout" ? `No se completó el pago en ${Math.round(waitMs / 60_000)} min.` : outcome.kind === "closed" ? "Se cerró la ventana de pago." : "La página de pago no se reconoció.";
    return unpaid(why);
  }
}

/** Buyer identity from config (never committed): CINES_LOGIN_EMAIL + CINES_BUYER_NAME ("First Last"). */
export function buyerFromEnv(env: NodeJS.ProcessEnv = process.env): () => Promise<Buyer> {
  return async () => {
    const email = env.CINES_LOGIN_EMAIL;
    const name = (env.CINES_BUYER_NAME ?? "").trim();
    if (!email || !name) throw new Error("faltan CINES_LOGIN_EMAIL / CINES_BUYER_NAME en cines.env");
    const [firstName, ...rest] = name.split(/\s+/);
    return { email, firstName: firstName!, lastName: rest.join(" ") || firstName! };
  };
}
