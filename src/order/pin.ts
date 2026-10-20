/**
 * PIN arming: lets the user arm ONE purchase from Telegram (hub secure input)
 * instead of `cinesctl arm-payment` at the Mac.
 *
 *   - set only at the Mac (`cinesctl set-arm-pin`, TTY); 6–8 digits;
 *   - stored as scrypt(pin, 16-byte salt) in a 0600 file, never the PIN;
 *   - verified in constant time; at most one attempt per 30 s;
 *   - 3 wrong in a row disable PIN arming until it is set again at the Mac;
 *   - callers log the outcome of an attempt, never the value.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CinesError } from "../errors.js";

export const PIN_RE = /^\d{6,8}$/;
export const PIN_MAX_FAILURES = 3;
export const PIN_MIN_INTERVAL_MS = 30_000;
const KEYLEN = 32;
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;

interface PinFile {
  v: 1;
  salt: string;
  hash: string;
  failures: number;
  disabled: boolean;
  lastAttemptAt?: string;
  setAt: string;
}

export interface PinStatus {
  configured: boolean;
  disabled: boolean;
  failures: number;
  /** Seconds until the next attempt is allowed (0 = now). */
  waitSeconds: number;
}

export type PinCheck = { ok: true } | { ok: false; disabled: boolean; attemptsLeft: number };

export class PinArm {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  private read(): PinFile | undefined {
    if (!existsSync(this.file)) return undefined;
    try {
      const f = JSON.parse(readFileSync(this.file, "utf8")) as PinFile;
      return f.v === 1 && f.salt && f.hash ? f : undefined;
    } catch {
      return undefined;
    }
  }

  private write(f: PinFile): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify(f), { mode: 0o600 });
  }

  private static derive(pin: string, salt: Buffer): Buffer {
    return scryptSync(pin, salt, KEYLEN, SCRYPT);
  }

  /** Set (or reset) the PIN; clears failures and re-enables. */
  set(pin: string): void {
    if (!PIN_RE.test(pin)) throw new CinesError("CINES_BAD_REQUEST", "El PIN debe tener de 6 a 8 dígitos.");
    if (/^(\d)\1+$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)) {
      throw new CinesError("CINES_BAD_REQUEST", "Elige un PIN menos obvio (no repetido ni consecutivo).");
    }
    const salt = randomBytes(16);
    this.write({ v: 1, salt: salt.toString("hex"), hash: PinArm.derive(pin, salt).toString("hex"), failures: 0, disabled: false, setAt: new Date(this.now()).toISOString() });
  }

  clear(): void {
    rmSync(this.file, { force: true });
  }

  status(): PinStatus {
    const f = this.read();
    if (!f) return { configured: false, disabled: false, failures: 0, waitSeconds: 0 };
    const last = f.lastAttemptAt ? Date.parse(f.lastAttemptAt) : 0;
    const wait = Math.max(0, Math.ceil((last + PIN_MIN_INTERVAL_MS - this.now()) / 1000));
    return { configured: true, disabled: f.disabled, failures: f.failures, waitSeconds: wait };
  }

  /** Usable right now: configured, not disabled. Throws a clear error if rate-limited. */
  usable(): boolean {
    const s = this.status();
    if (!s.configured) return false;
    if (s.disabled) {
      throw new CinesError("CINES_PAYMENT_FAILED", "El armado por PIN está desactivado tras 3 PIN incorrectos. En la Mac: bin/cinesctl set-arm-pin (o arm-payment).");
    }
    if (s.waitSeconds > 0) throw new CinesError("CINES_BAD_REQUEST", `Espera ${s.waitSeconds} s antes de intentar el PIN otra vez.`);
    return true;
  }

  /** One attempt (counts toward the rate limit and the failure streak). */
  verify(pin: string): PinCheck {
    const f = this.read();
    if (!f) return { ok: false, disabled: false, attemptsLeft: 0 };
    if (f.disabled) return { ok: false, disabled: true, attemptsLeft: 0 };
    const last = f.lastAttemptAt ? Date.parse(f.lastAttemptAt) : 0;
    if (this.now() - last < PIN_MIN_INTERVAL_MS) throw new CinesError("CINES_BAD_REQUEST", "Demasiado pronto para otro intento de PIN; espera 30 s.");
    f.lastAttemptAt = new Date(this.now()).toISOString();
    const want = Buffer.from(f.hash, "hex");
    const got = PIN_RE.test(pin) ? PinArm.derive(pin, Buffer.from(f.salt, "hex")) : Buffer.alloc(KEYLEN);
    const ok = got.length === want.length && timingSafeEqual(got, want) && PIN_RE.test(pin);
    if (ok) {
      f.failures = 0;
      this.write(f);
      return { ok: true };
    }
    f.failures += 1;
    f.disabled = f.failures >= PIN_MAX_FAILURES;
    this.write(f);
    return { ok: false, disabled: f.disabled, attemptsLeft: Math.max(0, PIN_MAX_FAILURES - f.failures) };
  }
}
