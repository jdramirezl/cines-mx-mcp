/**
 * Secure input broker.
 *
 * Some steps need a value only the user has (Cinépolis e-mail code, card CVV,
 * bank 3DS/OTP). The server opens a request; the tool returns
 * `{status:"needs_input", requestId, kind, prompt}`; the hub switches the chat
 * into secure-input mode and forwards the user's next reply straight to
 * `cines_secure_input` WITHOUT showing it to the model. Values are never
 * logged, persisted or echoed back.
 */
import { randomBytes } from "node:crypto";
import { CinesError } from "./errors.js";

export type SecureKind = "email_code" | "cvv" | "otp_3ds";

export const SECURE_FORMAT: Record<SecureKind, { re: RegExp; hint: string }> = {
  email_code: { re: /^\d{6}$/, hint: "6 dígitos" },
  cvv: { re: /^\d{3,4}$/, hint: "3 o 4 dígitos" },
  otp_3ds: { re: /^[0-9A-Za-z]{4,10}$/, hint: "4 a 10 caracteres" },
};

export interface SecureRequest {
  requestId: string;
  kind: SecureKind;
  prompt: string;
  expiresAt: string;
  /** Optional context image (e.g. a 3DS page screenshot) URL. */
  imageUrl?: string;
}

interface Pending extends SecureRequest {
  resolve: (v: string) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class SecureInputBroker {
  private readonly pending = new Map<string, Pending>();
  /** Listeners notified when a request opens (used by long-running tools to return early). */
  private readonly listeners = new Set<(r: SecureRequest) => void>();

  constructor(private readonly now: () => number = Date.now) {}

  onRequest(fn: (r: SecureRequest) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Open a request and wait for the value (rejects on timeout or cancel). */
  ask(kind: SecureKind, prompt: string, opts: { ttlMs?: number; imageUrl?: string; owner?: string } = {}): Promise<string> {
    const ttl = opts.ttlMs ?? 5 * 60_000;
    const requestId = `sec_${randomBytes(9).toString("hex")}`;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new CinesError("CINES_BAD_REQUEST", `No llegó el ${kind === "email_code" ? "código" : "dato"} a tiempo.`));
      }, ttl);
      timer.unref?.();
      const req: Pending = { requestId, kind, prompt, expiresAt: new Date(this.now() + ttl).toISOString(), imageUrl: opts.imageUrl, resolve, reject, timer };
      this.pending.set(requestId, req);
      for (const l of this.listeners) l(this.publicView(req));
    });
  }

  /** Called by `cines_secure_input`. Throws on unknown id or bad format (the request stays open on bad format). */
  submit(requestId: string, value: string): SecureKind {
    const p = this.pending.get(requestId);
    if (!p) throw new CinesError("CINES_NOT_FOUND", "Esa solicitud ya no está activa.");
    const v = value.replace(/\s+/g, "");
    if (!SECURE_FORMAT[p.kind].re.test(v)) throw new CinesError("CINES_BAD_REQUEST", `Formato inválido (${SECURE_FORMAT[p.kind].hint}).`);
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(v);
    return p.kind;
  }

  cancel(requestId: string, reason = "cancelado"): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.reject(new CinesError("CINES_BAD_REQUEST", `Solicitud ${reason}.`));
    return true;
  }

  list(): SecureRequest[] {
    return [...this.pending.values()].map((p) => this.publicView(p));
  }

  private publicView(p: Pending): SecureRequest {
    return { requestId: p.requestId, kind: p.kind, prompt: p.prompt, expiresAt: p.expiresAt, imageUrl: p.imageUrl };
  }
}

/**
 * Run `work` but return early if it opens a secure-input request first.
 * The work keeps running in the background; its outcome is retrievable via `job`.
 */
export async function runUntilInput<T>(
  broker: SecureInputBroker,
  work: () => Promise<T>,
  opts: { waitMs?: number } = {},
): Promise<{ done: true; value: T } | { done: false; request?: SecureRequest; job: Promise<T> }> {
  let off = () => false as boolean;
  const opened = new Promise<SecureRequest>((resolve) => {
    off = broker.onRequest(resolve) as unknown as () => boolean;
  });
  const job = work();
  job.catch(() => undefined);
  const timeout = new Promise<"timeout">((r) => {
    const t = setTimeout(() => r("timeout"), opts.waitMs ?? 110_000);
    t.unref?.();
  });
  try {
    const first = await Promise.race([job.then((value) => ({ value })), opened.then((request) => ({ request })), timeout]);
    if (first === "timeout") return { done: false, job };
    if ("value" in first) return { done: true, value: first.value };
    return { done: false, request: first.request, job };
  } finally {
    off();
  }
}
