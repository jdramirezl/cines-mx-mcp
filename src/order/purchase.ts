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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Hold, HoldService } from "../cinepolis/orders.js";
import { CinesError } from "../errors.js";
import type { SecureKind } from "../secure.js";

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
  /** Ask the user for a secret (CVV, 3DS/OTP); value goes straight to the driver. */
  ask: (kind: SecureKind, prompt: string, imageUrl?: string) => Promise<string>;
  log: (m: string) => void;
}

export interface PaymentDriver {
  readonly name: string;
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
  holdId: string;
  at: string;
  totalMxn: number;
  method: PaymentMethod | "dry-run";
  status: "started" | "paid" | "failed" | "unknown";
  bookingNumber?: string;
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
  userApproved?: boolean;
  dryRun?: boolean;
}

export interface PurchaseDeps {
  holds: HoldService;
  ledger: PurchaseLedger;
  driver: PaymentDriver;
  dryRunDriver?: PaymentDriver;
  ask: PaymentContext["ask"];
  cap?: number;
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
  if (!dryRun) {
    if (d.driver.name === "not-enabled") await d.driver.pay({ hold, method: args.method ?? "paypal", ask: d.ask, log });
    if (d.ledger.inFlight()) throw new CinesError("CINES_BAD_REQUEST", "Ya hay un pago en curso.");
    const prior = d.ledger.find(hold.holdId);
    if (prior) throw new CinesError("CINES_PAYMENT_FAILED", `Ya se intentó pagar este apartado (${prior.status}); nunca reintento un pago. Revisa tu correo.`);
  }
  const method = args.method ?? "paypal";
  const entry = d.ledger.add({ holdId: hold.holdId, at: new Date(now()).toISOString(), totalMxn: hold.totalMxn, method: dryRun ? "dry-run" : method, status: "started", dryRun });
  if (!dryRun) {
    hold.status = "purchasing";
    d.holds.update(hold);
  }
  const driver = dryRun ? (d.dryRunDriver ?? new DryRunDriver()) : d.driver;
  try {
    const r = await driver.pay({ hold, method, ask: d.ask, log });
    entry.status = "paid";
    entry.bookingNumber = r.bookingNumber;
    d.ledger.update(entry);
    if (!dryRun) {
      hold.status = "purchased";
      d.holds.update(hold);
    }
    return { status: "paid" as const, dryRun: dryRun || undefined, bookingNumber: r.bookingNumber, transactionNumber: r.transactionNumber, totalMxn: hold.totalMxn, seats: hold.seats, screenshotPath: r.screenshotPath };
  } catch (e) {
    const err = e instanceof CinesError ? e : new CinesError("CINES_PAYMENT_FAILED", (e as Error).message);
    // Unknown outcome = do not release, do not retry; the user checks their e-mail.
    entry.status = err.code === "CINES_PAYMENT_FAILED" ? "failed" : "unknown";
    entry.error = err.message.slice(0, 200);
    d.ledger.update(entry);
    if (!dryRun) {
      hold.status = "failed";
      d.holds.update(hold);
    }
    throw new CinesError(err.code === "CINES_PAYMENT_FAILED" ? "CINES_PAYMENT_FAILED" : err.code, `${err.message} No se reintentará el pago.`, { retryable: false });
  }
}
