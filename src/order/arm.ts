/**
 * One-shot payment arming.
 *
 * Real payment is disabled unless the user deliberately arms it on the server
 * Mac (`cinesctl arm-payment`, interactive). Arming writes a short-lived token
 * file (0600); the FIRST real `cines_purchase` consumes it before any payment
 * step runs, so it covers exactly one attempt, success or failure. It expires
 * after `minutes` (default 30, max 60). Never an env flag.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CinesError } from "../errors.js";

export const ARM_DEFAULT_MIN = 30;
export const ARM_MAX_MIN = 60;

/** A PIN arm covers one specific hold and total. */
export interface ArmBinding {
  holdId: string;
  totalMxn: number;
}

interface ArmFile {
  nonce: string;
  armedAt: string;
  expiresAt: string;
  via?: "mac" | "pin";
  bind?: ArmBinding;
}

export interface ArmStatus {
  armed: boolean;
  expiresAt?: string;
  minutesLeft?: number;
  via?: "mac" | "pin";
  holdId?: string;
}

export class PaymentArm {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  private read(): ArmFile | undefined {
    if (!existsSync(this.file)) return undefined;
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as ArmFile;
    } catch {
      return undefined;
    }
  }

  arm(minutes = ARM_DEFAULT_MIN, bind?: ArmBinding): ArmStatus {
    const m = Math.min(Math.max(1, Math.round(minutes)), ARM_MAX_MIN);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const f: ArmFile = { nonce: randomBytes(8).toString("hex"), armedAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + m * 60_000).toISOString(), via: bind ? "pin" : "mac", bind };
    writeFileSync(this.file, JSON.stringify(f), { mode: 0o600 });
    return this.status();
  }

  disarm(): void {
    rmSync(this.file, { force: true });
  }

  status(): ArmStatus {
    const f = this.read();
    if (!f) return { armed: false };
    const left = Date.parse(f.expiresAt) - this.now();
    if (left <= 0) {
      this.disarm();
      return { armed: false };
    }
    return { armed: true, expiresAt: f.expiresAt, minutesLeft: Math.ceil(left / 60_000), via: f.via ?? "mac", holdId: f.bind?.holdId };
  }

  /** Consume the arm for one payment attempt. Throws if not armed. Atomic across processes. */
  consume(target?: ArmBinding): void {
    const tmp = `${this.file}.consumed-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      renameSync(this.file, tmp); // only one consumer can win the rename
    } catch {
      throw new CinesError("CINES_PAYMENT_FAILED", "El pago real no está armado. En la Mac servidor: bin/cinesctl arm-payment (válido 30 min, un solo intento).");
    }
    let f: ArmFile | undefined;
    try {
      f = JSON.parse(readFileSync(tmp, "utf8")) as ArmFile;
    } catch {
      f = undefined;
    } finally {
      rmSync(tmp, { force: true });
    }
    if (!f || Date.parse(f.expiresAt) <= this.now()) {
      throw new CinesError("CINES_PAYMENT_FAILED", "El armado del pago expiró. Vuelve a armarlo con bin/cinesctl arm-payment.");
    }
    if (f.bind && (!target || f.bind.holdId !== target.holdId || Math.abs(f.bind.totalMxn - target.totalMxn) > 0.005)) {
      throw new CinesError("CINES_PAYMENT_FAILED", "El armado por PIN era para otro apartado o total; se descartó. Vuelve a intentarlo.");
    }
  }
}
