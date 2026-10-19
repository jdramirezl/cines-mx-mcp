/**
 * Secret scanner for files about to be committed or pushed.
 *
 * Refuses: HAR files, JWT/JWE, bearer tokens, private keys, real e-mail
 * addresses, Luhn-valid card numbers, phone numbers, images outside
 * test/golden, and any literal provided via CINES_SECRET_LITERALS (for example
 * the live x-apikey or the account holder's name) without committing it.
 */
import { BEARER_RE, EMAIL_RE, JWE_RE, JWT_RE, PHONE_RE, PRIVATE_KEY_RE, findCardNumbers } from "./patterns.js";

export interface Finding {
  file: string;
  line: number;
  kind: string;
  /** Short, masked excerpt; never the full secret. */
  excerpt: string;
}

/** E-mail addresses that are safe to appear in source (examples, noreply). */
const ALLOWED_EMAIL =
  /(@example\.(com|org|net)|@test\.invalid|@users\.noreply\.github\.com|^noreply@|^git@github\.com)$/i;

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf)$/i;

export function mask(s: string): string {
  if (s.length <= 8) return "*".repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;
}

export interface ScanOptions {
  literals?: string[];
}

export function scanPathPolicy(file: string): Finding[] {
  const f = file.replace(/\\/g, "/");
  const out: Finding[] = [];
  if (/\.har(\.json)?$/i.test(f)) out.push({ file, line: 0, kind: "har-file", excerpt: f });
  if (/(^|\/)\.env($|\.)/.test(f) && !f.endsWith(".env.example")) out.push({ file, line: 0, kind: "env-file", excerpt: f });
  if (/cookies?/i.test(f.split("/").pop() ?? "") && !/\.(ts|md)$/.test(f)) out.push({ file, line: 0, kind: "cookie-file", excerpt: f });
  if (BINARY_EXT.test(f) && /\.(png|jpe?g|gif|webp)$/i.test(f) && !f.startsWith("test/golden/")) {
    out.push({ file, line: 0, kind: "image-outside-golden", excerpt: f });
  }
  return out;
}

export function scanText(file: string, text: string, opts: ScanOptions = {}): Finding[] {
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);
  const literals = (opts.literals ?? []).map((l) => l.trim()).filter((l) => l.length >= 4);
  if (/"log"\s*:\s*\{[\s\S]{0,200}"entries"\s*:/.test(text.slice(0, 4000)) && !/Redacted by cines-mx-mcp/.test(text)) {
    out.push({ file, line: 1, kind: "unredacted-har-content", excerpt: "HAR log.entries" });
  }
  lines.forEach((line, i) => {
    const n = i + 1;
    const add = (kind: string, m: string) => out.push({ file, line: n, kind, excerpt: mask(m) });
    for (const m of line.matchAll(JWE_RE)) add("jwe", m[0]);
    for (const m of line.matchAll(JWT_RE)) add("jwt", m[0]);
    for (const m of line.matchAll(BEARER_RE)) if (!/\[(TOKEN|SECRET|JWT)/.test(m[0])) add("bearer", m[0]);
    for (const m of line.matchAll(PRIVATE_KEY_RE)) add("private-key", m[0]);
    for (const m of line.matchAll(EMAIL_RE)) if (!ALLOWED_EMAIL.test(m[0])) add("email", m[0]);
    for (const c of findCardNumbers(line)) add("card-number", c);
    for (const m of line.matchAll(PHONE_RE)) add("phone", m[0]);
    for (const lit of literals) if (line.toLowerCase().includes(lit.toLowerCase())) add("literal", lit);
    const apikey = /["']?x-?api-?key["']?\s*[:=]\s*["']([A-Za-z0-9_-]{20,})["']/i.exec(line);
    if (apikey?.[1]) add("api-key", apikey[1]);
  });
  return out;
}

export function isProbablyBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
