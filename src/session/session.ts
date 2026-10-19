/**
 * Cinépolis member session.
 *
 * The site uses auth0-spa-js with `cacheLocation: "localstorage"` and
 * `useRefreshTokens: true`: the access token (24 h) AND the rotating refresh
 * token live in the browser profile's localStorage. To avoid refresh-token
 * reuse detection (which revokes the whole session), the bot's browser
 * profile is the ONLY owner of the refresh token: we never call /oauth/token
 * ourselves; we let the site's own code refresh it and read the resulting
 * access token from localStorage.
 *
 * Recovery ladder when no valid token can be produced:
 *   1. load cinepolis.com in the bot profile so the SPA refreshes silently;
 *   2. e-mail code login in the bot profile, code read from the dedicated
 *      mailbox (IMAP, app password in Keychain);
 *   3. ask the user for the code via secure input (Telegram).
 */
import { CinesError } from "../errors.js";
import type { SecureInputBroker } from "../secure.js";

export interface CachedToken {
  accessToken: string;
  /** epoch ms */
  expiresAt: number;
  hasRefreshToken: boolean;
  audience?: string;
}

const AUTH0_PREFIX = "@@auth0spajs@@::";

/** Pick the access token from auth0-spa-js localStorage entries. Never returns the refresh token. */
export function parseAuth0Cache(entries: Record<string, string>, now = Date.now()): CachedToken | undefined {
  let best: CachedToken | undefined;
  for (const [k, raw] of Object.entries(entries)) {
    if (!k.startsWith(AUTH0_PREFIX)) continue;
    // @@auth0spajs@@::<clientId>::<audience>::<scope>  (audience may contain ":")
    const parts = k.slice(AUTH0_PREFIX.length).split("::");
    if (parts.length < 3 || parts.includes("@@user@@")) continue;
    const audience = parts[1];
    let v: { body?: { access_token?: string; refresh_token?: string; expires_in?: number }; expiresAt?: number };
    try {
      v = JSON.parse(raw);
    } catch {
      continue;
    }
    const tok = v.body?.access_token;
    if (!tok) continue;
    const exp = typeof v.expiresAt === "number" ? (v.expiresAt < 1e12 ? v.expiresAt * 1000 : v.expiresAt) : now + (v.body?.expires_in ?? 0) * 1000;
    const cand: CachedToken = { accessToken: tok, expiresAt: exp, hasRefreshToken: Boolean(v.body?.refresh_token), audience };
    if (!best || cand.expiresAt > best.expiresAt) best = cand;
  }
  return best;
}

/** Decode a JWT `exp` (seconds) without verifying it. */
export function jwtExpiry(token: string): number | undefined {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number };
    return typeof p.exp === "number" ? p.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** What the session manager needs from the bot browser. */
export interface SessionBrowser {
  /** Load the site so auth0-spa-js refreshes; return the localStorage auth0 entries. */
  refresh(): Promise<Record<string, string>>;
  /** Run the e-mail code login; `getCode` is called once after the code e-mail is requested. */
  loginWithEmailCode(email: string, getCode: (requestedAt: number) => Promise<string>): Promise<Record<string, string>>;
}

export interface CodeMailbox {
  /** Wait for a Cinépolis code that arrived after `since`; resolves undefined on timeout. */
  waitForCode(since: number, timeoutMs: number): Promise<string | undefined>;
}

export interface SessionStatus {
  state: "valid" | "expiring" | "expired" | "unknown";
  expiresAt?: string;
  hasRefreshToken?: boolean;
  lastRefreshAt?: string;
  lastLoginAt?: string;
  mailbox: boolean;
}

export interface SessionManagerOptions {
  browser?: SessionBrowser;
  mailbox?: CodeMailbox;
  broker?: SecureInputBroker;
  loginEmail?: string;
  now?: () => number;
  /** Refresh when fewer than this many ms remain (default 2 h). */
  refreshMarginMs?: number;
  /** Static token for development (CINES_ACCESS_TOKEN). Never logged. */
  staticToken?: string;
  log?: (msg: string) => void;
}

export class SessionManager {
  private cached?: CachedToken;
  private inflight?: Promise<string>;
  private lastRefreshAt?: number;
  private lastLoginAt?: number;
  private readonly now: () => number;
  private readonly margin: number;
  private readonly log: (m: string) => void;

  constructor(private readonly o: SessionManagerOptions = {}) {
    this.now = o.now ?? Date.now;
    this.margin = o.refreshMarginMs ?? 2 * 3_600_000;
    this.log = o.log ?? ((m) => console.error(`[session] ${m}`));
    if (o.staticToken) {
      const exp = jwtExpiry(o.staticToken) ?? this.now() + 3_600_000;
      this.cached = { accessToken: o.staticToken, expiresAt: exp, hasRefreshToken: false };
    }
  }

  status(): SessionStatus {
    const c = this.cached;
    const left = c ? c.expiresAt - this.now() : -1;
    return {
      state: !c ? "unknown" : left <= 0 ? "expired" : left < this.margin ? "expiring" : "valid",
      expiresAt: c ? new Date(c.expiresAt).toISOString() : undefined,
      hasRefreshToken: c?.hasRefreshToken,
      lastRefreshAt: this.lastRefreshAt ? new Date(this.lastRefreshAt).toISOString() : undefined,
      lastLoginAt: this.lastLoginAt ? new Date(this.lastLoginAt).toISOString() : undefined,
      mailbox: Boolean(this.o.mailbox),
    };
  }

  /** A valid access token, recovering through the ladder if needed. Single-flight. */
  async getAccessToken(opts: { allowLogin?: boolean } = {}): Promise<string> {
    const c = this.cached;
    if (c && c.expiresAt - this.now() > 10 * 60_000) {
      if (c.expiresAt - this.now() < this.margin) void this.keepAlive().catch(() => undefined);
      return c.accessToken;
    }
    this.inflight ??= this.recover(opts.allowLogin ?? true).finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  /** Background keepalive: let the site refresh the token. Safe to call often. */
  async keepAlive(): Promise<SessionStatus> {
    if (!this.o.browser) return this.status();
    try {
      const t = parseAuth0Cache(await this.o.browser.refresh(), this.now());
      this.lastRefreshAt = this.now();
      if (t) {
        const prev = this.cached?.expiresAt;
        this.cached = t;
        this.log(`keepalive: token valid until ${new Date(t.expiresAt).toISOString()}${prev && t.expiresAt > prev ? " (renewed)" : ""}`);
      } else this.log("keepalive: no auth0 token in profile");
    } catch (e) {
      this.log(`keepalive failed: ${(e as Error).message}`);
    }
    return this.status();
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async recover(allowLogin: boolean): Promise<string> {
    if (this.o.browser) {
      await this.keepAlive();
      const c = this.cached;
      if (c && c.expiresAt - this.now() > 10 * 60_000) return c.accessToken;
    }
    if (!allowLogin) throw new CinesError("CINES_SESSION_EXPIRED", "La sesión de Cinépolis expiró.");
    if (!this.o.browser || !this.o.loginEmail) {
      throw new CinesError("CINES_SESSION_EXPIRED", "La sesión de Cinépolis expiró y no hay login automático configurado (cines login).");
    }
    const entries = await this.o.browser.loginWithEmailCode(this.o.loginEmail, (since) => this.getCode(since));
    const t = parseAuth0Cache(entries, this.now());
    if (!t) throw new CinesError("CINES_SESSION_EXPIRED", "El login con código no produjo una sesión.");
    this.cached = t;
    this.lastLoginAt = this.now();
    this.log(`login ok; token valid until ${new Date(t.expiresAt).toISOString()}`);
    return t.accessToken;
  }

  /** Mailbox first (deterministic), then the user via secure input. One code, one attempt. */
  private async getCode(since: number): Promise<string> {
    if (this.o.mailbox) {
      const code = await this.o.mailbox.waitForCode(since, 150_000).catch((e: unknown) => {
        this.log(`mailbox error: ${(e as Error).message}`);
        return undefined;
      });
      if (code) {
        this.log("login code received from mailbox");
        return code;
      }
    }
    if (!this.o.broker) throw new CinesError("CINES_SESSION_EXPIRED", "No llegó el código de Cinépolis.");
    return this.o.broker.ask("email_code", "Cinépolis te mandó un código de 6 dígitos a tu correo. Escríbelo aquí (no lo verá el asistente).", {
      ttlMs: 9 * 60_000,
    });
  }
}
