/**
 * Patterns shared by the HAR redactor and the secret scanner.
 *
 * Kept deliberately conservative: a false positive costs a manual review,
 * a false negative leaks a session token into a public repo.
 */
import { createHash, randomBytes } from "node:crypto";

/** `orderSessionId` / `order-session-id` / `ORDER_SESSION_ID` -> `order_session_id`. */
export function normalizeKey(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

/**
 * Header / query / JSON key names whose values are always secret.
 * Matched against the normalized (snake_case) name; a match on any `_`-delimited
 * segment run counts. Public ids such as a showtime `sessionId` are NOT secret.
 */
const SENSITIVE_NAME =
  /(^|_)(authorization|cookie|set_cookie|x_?apikey|x_?api_?key|apikey|api_?key|token|access_token|refresh_token|id_token|user_token|order_token|secret|client_secret|password|passwd|signature|user_session_id|order_session_id|csrf|x_?csrf_?token|recaptcha|g_recaptcha_response|captcha|otp|code_verifier|cvv|cvc|card_number|pan)($|_)/;

/** JSON keys that hold personal data (values replaced, keys kept). */
const PERSONAL_KEY =
  /^(e_?mail|email_address|first_name|last_name|middle_name|full_name|given_name|family_name|nickname|picture|avatar|phone|phone_number|mobile|cellphone|birth_date|birthday|date_of_birth|street|zip|postal_code|national_id|nationalid|curp|rfc|tcc|membership_id|membership|member_id|sub|user_id|order_user_id|orderuserid|ip|ip_address|device_id|fingerprint)$/;

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME.test(normalizeKey(name));
}

export function isPersonalKey(key: string): boolean {
  return PERSONAL_KEY.test(normalizeKey(key));
}

export const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
// JWE (5 parts, first part base64 JSON with "alg":"dir" etc.)
export const JWE_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g;
export const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
/**
 * 13-19 digits, optionally separated by single spaces or dashes. Not part of a
 * decimal number or a longer digit run (timings like 2.21800000872463).
 * Luhn-checked before use.
 */
const CARD_CANDIDATE_RE = /(?<![\d.,])(?:\d[ -]?){12,18}\d(?![\d.,]\d)/g;
/** International phone numbers: `+<country> <area> <3-4 digits> <4 digits>`. */
export const PHONE_RE = /\+\d{1,3}[ -]?\(?\d{2,3}\)?[ -]?\d{3,4}[ -]?\d{4}\b/g;
/** Long opaque tokens (hex or base64url) that are not plain numbers. */
const LONG_TOKEN_RE = /\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}\b/g;

export function luhn(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function findCardNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CARD_CANDIDATE_RE)) {
    const raw = m[0];
    const digits = raw.replace(/\D/g, "");
    // Skip all-same-digit runs and epoch-ms-like timestamps (13 digits starting with 1).
    if (/^(\d)\1+$/.test(digits)) continue;
    if (digits.length === 13 && digits.startsWith("1")) continue;
    if (luhn(digits)) out.push(raw);
  }
  return out;
}

export interface Hasher {
  (value: string, kind?: string): string;
}

/** Salted, per-run hasher: equal inputs map to equal markers within one run only. */
export function makeHasher(salt: string = randomBytes(16).toString("hex")): Hasher {
  return (value: string, kind = "REDACTED") => {
    const h = createHash("sha256").update(salt).update(value).digest("hex").slice(0, 8);
    return `[${kind}:${h}]`;
  };
}

export interface ScrubOptions {
  /** Extra literal strings to remove (e.g. the account holder's name). Case-insensitive. */
  literals?: string[];
  hash: Hasher;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Scrub free text: JWTs, bearer tokens, emails, card numbers, phones, literals, long tokens. */
export function scrubText(text: string, opts: ScrubOptions): string {
  const { hash } = opts;
  let out = text;
  out = out.replace(JWE_RE, (m) => hash(m, "JWE"));
  out = out.replace(JWT_RE, (m) => hash(m, "JWT"));
  out = out.replace(BEARER_RE, (m) => `Bearer ${hash(m, "TOKEN")}`);
  out = out.replace(PRIVATE_KEY_RE, "[PRIVATE_KEY]");
  out = out.replace(EMAIL_RE, (m) => hash(m.toLowerCase(), "EMAIL"));
  for (const card of findCardNumbers(out)) out = out.split(card).join("[CARD]");
  out = out.replace(PHONE_RE, "[PHONE]");
  for (const lit of opts.literals ?? []) {
    const l = lit.trim();
    if (l.length < 3) continue;
    out = out.replace(new RegExp(escapeRe(l), "gi"), "[PERSON]");
  }
  out = out.replace(LONG_TOKEN_RE, (m) => hash(m, "TOKEN"));
  return out;
}
