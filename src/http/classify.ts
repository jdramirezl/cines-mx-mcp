/**
 * Response classification. Turns raw HTTP results into data or a CinesError,
 * distinguishing a Cloudflare block (back off, do not hammer) from a transient
 * outage (retry) from a contract change (stop and warn).
 */
import { CinesError } from "../errors.js";
import type { HttpResponse } from "./transport.js";

export type Classification =
  | { kind: "ok" }
  | { kind: "cloudflare-block" }
  | { kind: "cloudflare-challenge" }
  | { kind: "unauthorized" }
  | { kind: "rate-limited" }
  | { kind: "server-error" }
  | { kind: "not-json" }
  | { kind: "client-error" };

const CF_BLOCK = /Sorry, you have been blocked|Attention Required! \| Cloudflare|You are unable to access|cf-error-details/i;
const CF_CHALLENGE = /Just a moment\.\.\.|cf-chl-|challenge-platform|cf_chl_opt|Checking your browser/i;

export function classify(res: HttpResponse): Classification {
  const server = String(res.headers["server"] ?? "").toLowerCase();
  const isHtml = /^\s*</.test(res.text);
  if ((res.status === 403 || res.status === 503 || res.status === 429) && isHtml) {
    if (CF_CHALLENGE.test(res.text)) return { kind: "cloudflare-challenge" };
    if (CF_BLOCK.test(res.text) || server.includes("cloudflare")) return { kind: "cloudflare-block" };
  }
  if (res.status === 401) return { kind: "unauthorized" };
  if (res.status === 429) return { kind: "rate-limited" };
  if (res.status >= 500) return { kind: "server-error" };
  if (res.status >= 400) return { kind: "client-error" };
  if (isHtml) return { kind: "not-json" };
  return { kind: "ok" };
}

/** Raise the matching CinesError for a non-ok classification. */
export function errorFor(c: Classification, res: HttpResponse, what: string): CinesError {
  switch (c.kind) {
    case "cloudflare-block":
      return new CinesError("CINES_BLOCKED", `Cinépolis blocked the request (${what}); backing off`, { retryable: false, detail: `HTTP ${res.status}` });
    case "cloudflare-challenge":
      return new CinesError("CINES_BLOCKED", `Cinépolis asked for a browser challenge (${what})`, { retryable: false });
    case "unauthorized":
      return new CinesError("CINES_SESSION_EXPIRED", `Cinépolis rejected the credentials (${what})`, { detail: `HTTP ${res.status}` });
    case "rate-limited":
      return new CinesError("CINES_UNAVAILABLE", `Cinépolis is rate limiting (${what}); try again shortly`, { retryable: true });
    case "server-error":
      return new CinesError("CINES_UNAVAILABLE", `Cinépolis is unavailable (${what}, HTTP ${res.status})`, { retryable: true });
    case "not-json":
      return new CinesError("CINES_SCHEMA_CHANGED", `Unexpected non-JSON response from Cinépolis (${what})`, { detail: `HTTP ${res.status}` });
    case "client-error":
      return new CinesError("CINES_BAD_REQUEST", `Cinépolis rejected the request (${what}, HTTP ${res.status})`);
    case "ok":
      return new CinesError("CINES_UNAVAILABLE", "no error");
  }
}
