/**
 * Purchase guardrails and the deterministic purchase runner.
 *
 * Server-side rules (also enforced by the hub):
 *   - hard cap: never pay more than CINES_PURCHASE_CAP_MXN (default and maximum 1000);
 *   - the first 3 purchases must be explicitly approved by the user (the hub shows the ✅/❌
 *     card; the tool requires `userApproved: true` while fewer than 3 purchases succeeded);
 *   - `expectedTotalMxn` must match the hold exactly (no drift between card and charge);
 *   - one purchase in flight; a hold is paid at most once; a payment is never retried;
 *   - any unexpected page stops the run with a screenshot.
 * The language model never drives the payment page: the driver is code.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Hold, HoldService } from "../cinepolis/orders.js";
import { CinesError } from "../errors.js";
import type { SecureKind } from "../secure.js";
import type { PaymentArm } from "./arm.js";
import type { PinArm } from "./pin.js";

export const PIN_ARM_MIN = 10;

export const HARD_CAP_MXN = 1000;
export const APPROVAL_FREE_AFTER = 3;

export type PaymentMethod = "paypal" | "card";

export interface PaymentResult {
  bookingNumber: string;
  transactionNumber?: string;
  screenshotPath?: string;
}

export interface PaymentContext {
  hold: Hold;
  method: PaymentMethod;
  /** Saved card to use (last four digits), when the user named one. */
  cardLast4?: string;
  /** Ask the user for a secret (CVV, 3DS/OTP); value goes straight to the driver. */
  ask: (kind: SecureKind, prompt: string, imageUrl?: string) => Promise<string>;
  log: (m: string) => void;
}

export interface PaymentDriver {
  readonly name: string;
  /** Methods this driver can run (default: all). Checked BEFORE the arm is consumed. */
  supports?(method: PaymentMethod): boolean;
  /**
   * Throw CINES_PAYMENT_FAILED only when certain nothing was charged (and the
   * hold was released or is about to expire); any other error = outcome unknown.
   */
  pay(ctx: PaymentContext): Promise<PaymentResult>;
}

/** Simulated payment for tests and `dryRun: true`. Never touches Cinépolis payment endpoints. */
export class DryRunDriver implements PaymentDriver {
  readonly name = "dry-run";
  constructor(private readonly opts: { askFor?: SecureKind; fail?: string } = {}) {}
  async pay(ctx: PaymentContext): Promise<PaymentResult> {
    ctx.log(`dry-run: would pay $${ctx.hold.totalMxn} with ${ctx.method}`);
    if (this.opts.askFor) await ctx.ask(this.opts.askFor, "Simulación: escribe el código.");
    if (this.opts.fail) throw new CinesError("CINES_PAYMENT_FAILED", this.opts.fail);
    return { bookingNumber: `DRYRUN-${ctx.hold.holdId.slice(-6).toUpperCase()}` };
  }
}

/** Placeholder until the live payment flow is verified with the user watching (Task 12). */
export class NotYetEnabledDriver implements PaymentDriver {
  readonly name = "not-enabled";
  async pay(): Promise<PaymentResult> {
    throw new CinesError(
      "CINES_PAYMENT_FAILED",
      "El pago real aún no está habilitado: falta la verificación en vivo con el usuario (PayPal en el navegador del bot). Usa dryRun.",
    );
  }
}

export interface LedgerEntry {
  purchaseId?: string;
  holdId: string;
  at: string;
  totalMxn: number;
  method: PaymentMethod | "dry-run";
  status: "started" | "paid" | "failed" | "unknown";
  bookingNumber?: string;
  screenshotPath?: string;
  imageUrl?: string;
  error?: string;
  dryRun?: boolean;
}

export class PurchaseLedger {
  private entries: LedgerEntry[] = [];
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        this.entries = JSON.parse(readFileSync(file, "utf8")) as LedgerEntry[];
      } catch {
        this.entries = [];
      }
    }
  }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify(this.entries, null, 1), { mode: 0o600 });
  }
  successes(): number {
    return this.entries.filter((e) => e.status === "paid" && !e.dryRun).length;
  }
  find(holdId: string, dryRun = false): LedgerEntry | undefined {
    return this.entries.find((e) => e.holdId === holdId && Boolean(e.dryRun) === dryRun);
  }
  inFlight(): LedgerEntry | undefined {
    return this.entries.find((e) => e.status === "started" && !e.dryRun);
  }
  add(e: LedgerEntry): LedgerEntry {
    this.entries.push(e);
    this.save();
    return e;
  }
  update(_e: LedgerEntry): void {
    this.save();
  }
  recent(n = 5): LedgerEntry[] {
    return this.entries.slice(-n);
  }
}

export function capMxn(env = process.env): number {
  const v = Number(env.CINES_PURCHASE_CAP_MXN ?? HARD_CAP_MXN);
  return Number.isFinite(v) && v > 0 ? Math.min(v, HARD_CAP_MXN) : HARD_CAP_MXN;
}

export interface PurchaseArgs {
  holdId: string;
  expectedTotalMxn: number;
  method?: PaymentMethod;
  cardLast4?: string;
  userApproved?: boolean;
  dryRun?: boolean;
}

export const DEFAULT_METHOD: PaymentMethod = "card";

/** Routes each method to its driver; `supports` is checked before the arm is consumed. */
export class MethodRouter implements PaymentDriver {
  readonly name = "router";
  constructor(private readonly drivers: Partial<Record<PaymentMethod, PaymentDriver>>) {}
  supports(method: PaymentMethod): boolean {
    const d = this.drivers[method];
    return Boolean(d) && (d!.supports ? d!.supports(method) : true);
  }
  pay(ctx: PaymentContext): Promise<PaymentResult> {
    const d = this.drivers[ctx.method];
    if (!d) throw new CinesError("CINES_BAD_REQUEST", `Método "${ctx.method}" no disponible.`);
    return d.pay(ctx);
  }
}

export interface PurchaseDeps {
  holds: HoldService;
  ledger: PurchaseLedger;
  driver: PaymentDriver;
  dryRunDriver?: PaymentDriver;
  ask: PaymentContext["ask"];
  cap?: number;
  /** One-shot arm consumed by the first real attempt; missing = real payment disabled. */
  arm?: PaymentArm;
  /** Optional PIN arming from the hub's secure input when the server is not armed. */
  pin?: PinArm;
  now?: () => number;
  log?: (m: string) => void;
}

export function approvalRequired(ledger: PurchaseLedger): boolean {
  return ledger.successes() < APPROVAL_FREE_AFTER;
}

/** Validate everything, then run the driver exactly once. */
export async function purchase(args: PurchaseArgs, d: PurchaseDeps) {
  const now = d.now ?? Date.now;
  const log = d.log ?? ((m: string) => console.error(`[purchase] ${m}`));
  const dryRun = args.dryRun === true;
  if (args.cardLast4 !== undefined && !/^\d{4}$/.test(args.cardLast4)) throw new CinesError("CINES_BAD_REQUEST", "cardLast4 debe ser 4 dígitos.");
  const hold = d.holds.get(args.holdId);
  if (!hold) throw new CinesError("CINES_NOT_FOUND", "No conozco ese apartado de asientos.");
  if (hold.status === "purchased") throw new CinesError("CINES_BAD_REQUEST", "Esa compra ya se hizo.");
  if (hold.status !== "held") throw new CinesError("CINES_HOLD_EXPIRED", "Esos asientos ya no están apartados; vuelve a elegirlos.");
  if (Date.parse(hold.expiresAt) <= now()) throw new CinesError("CINES_HOLD_EXPIRED", "El tiempo para pagar se acabó; vuelve a elegir asientos.");
  const cap = Math.min(d.cap ?? HARD_CAP_MXN, HARD_CAP_MXN);
  if (hold.totalMxn > cap) throw new CinesError("CINES_LIMIT_EXCEEDED", `El total $${hold.totalMxn} supera el límite de $${cap}.`);
  if (Math.abs(hold.totalMxn - args.expectedTotalMxn) > 0.005) {
    throw new CinesError("CINES_BAD_REQUEST", `El total no coincide: apartado $${hold.totalMxn}, esperado $${args.expectedTotalMxn}. Vuelve a confirmar con el usuario.`);
  }
  if (!dryRun && approvalRequired(d.ledger) && args.userApproved !== true) {
    throw new CinesError("CINES_BAD_REQUEST", `Las primeras ${APPROVAL_FREE_AFTER} compras requieren la aprobación explícita del usuario (userApproved: true tras el ✅).`);
  }
  const method = args.method ?? DEFAULT_METHOD;
  if (!dryRun) {
    if (d.driver.name === "not-enabled") await d.driver.pay({ hold, method, cardLast4: args.cardLast4, ask: d.ask, log });
    if (d.driver.supports && !d.driver.supports(method)) throw new CinesError("CINES_BAD_REQUEST", `El método "${method}" no está disponible en este servidor.`);
    if (d.ledger.inFlight()) throw new CinesError("CINES_BAD_REQUEST", "Ya hay un pago en curso.");
    const prior = d.ledger.find(hold.holdId);
    if (prior) throw new CinesError("CINES_PAYMENT_FAILED", `Ya se intentó pagar este apartado (${prior.status}); nunca reintento un pago. Revisa tu correo.`);
    if (!d.arm) throw new CinesError("CINES_PAYMENT_FAILED", "El pago real no está habilitado en este servidor.");
    const target = { holdId: hold.holdId, totalMxn: hold.totalMxn };
    if (!d.arm.status().armed && d.pin?.usable()) {
      // Not armed at the Mac: arm this one purchase with the user's PIN (secure input, never logged).
      const pin = await d.ask("arm_pin", `Escribe tu PIN de compras para autorizar este pago de $${hold.totalMxn} MXN.`);
      const r = d.pin.verify(pin);
      log(`arm pin attempt: ${r.ok ? "ok" : "wrong"}`);
      if (!r.ok) {
        throw new CinesError(
          "CINES_PAYMENT_FAILED",
          r.disabled
            ? "PIN incorrecto. Desactivé el armado por PIN; en la Mac: bin/cinesctl set-arm-pin. No se cobró nada."
            : `PIN incorrecto (te quedan ${r.attemptsLeft} intento${r.attemptsLeft === 1 ? "" : "s"}; espera 30 s). No se cobró nada.`,
        );
      }
      const cur = d.holds.get(hold.holdId);
      if (!cur || cur.status !== "held" || Date.parse(cur.expiresAt) <= now()) throw new CinesError("CINES_HOLD_EXPIRED", "Los asientos se liberaron mientras esperaba el PIN; vuelve a elegirlos.");
      d.arm.arm(PIN_ARM_MIN, target);
      log("payment armed by pin for this hold");
    }
    d.arm.consume(target); // one attempt per arm, whatever happens next
    log("payment arm consumed");
  }
  const entry = d.ledger.add({ purchaseId: `pur_${randomBytes(6).toString("hex")}`, holdId: hold.holdId, at: new Date(now()).toISOString(), totalMxn: hold.totalMxn, method: dryRun ? "dry-run" : method, status: "started", dryRun });
  if (!dryRun) {
    hold.status = "purchasing";
    d.holds.update(hold);
  }
  const driver = dryRun ? (d.dryRunDriver ?? new DryRunDriver()) : d.driver;
  try {
    const r = await driver.pay({ hold, method, cardLast4: args.cardLast4, ask: d.ask, log });
    entry.status = "paid";
    entry.bookingNumber = r.bookingNumber;
    entry.screenshotPath = r.screenshotPath;
    d.ledger.update(entry);
    if (!dryRun) {
      hold.status = "purchased";
      d.holds.update(hold);
    }
    return { status: "paid" as const, purchaseId: entry.purchaseId, dryRun: dryRun || undefined, bookingNumber: r.bookingNumber, transactionNumber: r.transactionNumber, total: hold.totalMxn, currency: "MXN" as const, totalMxn: hold.totalMxn, seats: hold.seats, screenshotPath: r.screenshotPath };
  } catch (e) {
    const err = e instanceof CinesError ? e : new CinesError("CINES_PAYMENT_FAILED", (e as Error).message);
    // Unknown outcome = do not release, do not retry; the user checks their e-mail.
    entry.status = err.code === "CINES_PAYMENT_FAILED" ? "failed" : "unknown";
    entry.error = err.message.slice(0, 200);
    d.ledger.update(entry);
    if (!dryRun) {
      const cur = d.holds.get(hold.holdId);
      if (cur && cur.status === "purchasing") {
        cur.status = "failed";
        d.holds.update(cur);
      }
    }
    throw new CinesError(err.code === "CINES_PAYMENT_FAILED" ? "CINES_PAYMENT_FAILED" : err.code, `${err.message} No se reintentará el pago.`, { retryable: false });
  }
}
