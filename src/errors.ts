/** Shared error type. Every tool failure is surfaced as `{error:{code,message,retryable}}`. */

export type CinesErrorCode =
  | "CINES_BLOCKED"
  | "CINES_UNAVAILABLE"
  | "CINES_SCHEMA_CHANGED"
  | "CINES_NOT_FOUND"
  | "CINES_BAD_REQUEST"
  | "CINES_SESSION_EXPIRED"
  | "CINES_HOLD_EXPIRED"
  | "CINES_PAYMENT_FAILED"
  | "CINES_LIMIT_EXCEEDED"
  | "CINES_CONFIG";

const RETRYABLE: ReadonlySet<CinesErrorCode> = new Set(["CINES_UNAVAILABLE"]);

export class CinesError extends Error {
  readonly code: CinesErrorCode;
  readonly retryable: boolean;
  /** Internal detail for logs only (never contains secrets). */
  readonly detail?: string;

  constructor(code: CinesErrorCode, message: string, opts: { retryable?: boolean; detail?: string; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "CinesError";
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE.has(code);
    this.detail = opts.detail;
  }

  toJSON(): ErrorShape {
    return { error: { code: this.code, message: this.message, retryable: this.retryable } };
  }
}

export interface ErrorShape {
  error: { code: CinesErrorCode; message: string; retryable: boolean };
}

export function toErrorShape(err: unknown): ErrorShape {
  if (err instanceof CinesError) return err.toJSON();
  const message = err instanceof Error ? err.message : String(err);
  return { error: { code: "CINES_UNAVAILABLE", message: `Unexpected error: ${message}`, retryable: true } };
}
