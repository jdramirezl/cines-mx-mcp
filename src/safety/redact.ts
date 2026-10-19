/**
 * HAR redaction.
 *
 * Keeps the structure needed for analysis and fixtures (URLs, methods, status,
 * header and cookie NAMES, cookie attributes such as expiry, GraphQL queries,
 * response shapes) and replaces every secret or personal value with a salted
 * hash marker, so equal values stay correlatable within one redaction run.
 */
import {
  type Hasher,
  isPersonalKey,
  isSensitiveName,
  makeHasher,
  scrubText,
} from "./patterns.js";

export interface RedactOptions {
  /** Literal personal strings (names) to remove everywhere. */
  literals?: string[];
  /** Fixed salt for deterministic tests. */
  salt?: string;
  /** Drop base64 bodies (images, fonts). Default true. */
  dropBinaryBodies?: boolean;
}

interface NameValue {
  name: string;
  value: string;
  [k: string]: unknown;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface RedactStats {
  entries: number;
  headersRedacted: number;
  cookiesRedacted: number;
  bodiesScrubbed: number;
  binaryBodiesDropped: number;
  trackerEntries: number;
}

/**
 * Third-party analytics / ad / fingerprinting hosts. Their payloads are useless
 * for analysis and full of device fingerprints, so bodies are dropped and every
 * query value is hashed.
 */
const TRACKER_HOST =
  /(^|\.)(facebook\.com|facebook\.net|tiktok\.com|google-analytics\.com|analytics\.google\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|google\.com(\.mx)?|2mdn\.net|adtrafficquality\.google|pinterest\.com|dynatrace\.com|quantserve\.com|quantcount\.com|riskified\.com|online-metrix\.net|amplitude\.com|rudder-one\.deuna\.com|logr-in\.com|adsafeprotected\.com|clarity\.ms|hotjar\.com|featureassets\.org|prodregistryv2\.org|on\.aws|run\.app|gravatar\.com|hexagon-analytics\.com|bf\.dynatrace\.com)$/i;

export function isTrackerUrl(raw: string): boolean {
  try {
    return TRACKER_HOST.test(new URL(raw).hostname);
  } catch {
    return false;
  }
}

export class Redactor {
  readonly stats: RedactStats = {
    entries: 0,
    headersRedacted: 0,
    cookiesRedacted: 0,
    bodiesScrubbed: 0,
    binaryBodiesDropped: 0,
    trackerEntries: 0,
  };
  private readonly hash: Hasher;
  private readonly literals: string[];
  private readonly dropBinary: boolean;

  constructor(opts: RedactOptions = {}) {
    this.hash = makeHasher(opts.salt);
    this.literals = (opts.literals ?? []).filter((l) => l.trim().length >= 3);
    this.dropBinary = opts.dropBinaryBodies ?? true;
  }

  text(s: string): string {
    let out = s;
    for (const v of this.knownSecrets) if (out.includes(v)) out = out.split(v).join(this.hash(v, "SECRET"));
    return scrubText(out, { hash: this.hash, literals: this.literals });
  }

  /** Values seen in cookies / sensitive headers anywhere in the HAR are scrubbed everywhere. */
  private readonly knownSecrets = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private collectKnownSecrets(entries: any[]): void {
    const add = (v: unknown) => {
      if (typeof v !== "string") return;
      const s = v.replace(/^Bearer\s+/i, "").trim();
      if (s.length >= 8) this.knownSecrets.add(s);
      for (const part of s.split(/;\s*/)) {
        const val = part.split("=").slice(1).join("=");
        if (val.length >= 8) this.knownSecrets.add(val);
      }
    };
    for (const e of entries) {
      for (const side of [e?.request, e?.response]) {
        for (const c of side?.cookies ?? []) add(c?.value);
        for (const h of side?.headers ?? []) if (isSensitiveName(h?.name ?? "")) add(h?.value);
      }
    }
  }

  private secret(v: string, kind = "REDACTED"): string {
    return v === "" ? "" : this.hash(v, kind);
  }

  /** Deep-scrub parsed JSON: secret/personal keys hashed, every string scrubbed. */
  json(value: Json, key?: string): Json {
    if (key !== undefined && (isSensitiveName(key) || isPersonalKey(key))) {
      if (value === null || value === "") return value;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return this.secret(String(value), isPersonalKey(key) ? "PII" : "SECRET");
      }
      // Objects / arrays under a secret key: recurse, but hash every leaf.
      return this.hashLeaves(value);
    }
    if (typeof value === "string") return this.maybeNestedJson(value);
    if (Array.isArray(value)) return value.map((v) => this.json(v));
    if (value && typeof value === "object") {
      const out: { [k: string]: Json } = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.json(v, k);
      return out;
    }
    return value;
  }

  private hashLeaves(value: Json): Json {
    if (Array.isArray(value)) return value.map((v) => this.hashLeaves(v));
    if (value && typeof value === "object") {
      const out: { [k: string]: Json } = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.hashLeaves(v);
      return out;
    }
    if (value === null || value === "") return value;
    return this.secret(String(value), "SECRET");
  }

  /** Strings that are themselves JSON (ASP.NET `{"d":"..."}`, GraphQL bodies) are scrubbed structurally. */
  private maybeNestedJson(s: string): string {
    const t = s.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try {
        return JSON.stringify(this.json(JSON.parse(t) as Json));
      } catch {
        /* not JSON */
      }
    }
    return this.text(s);
  }

  body(text: string | undefined, mimeType = ""): string | undefined {
    if (text === undefined || text === "") return text;
    this.stats.bodiesScrubbed++;
    if (/json|graphql/i.test(mimeType) || /^\s*[[{]/.test(text)) {
      try {
        return JSON.stringify(this.json(JSON.parse(text) as Json));
      } catch {
        /* fall through */
      }
    }
    if (/x-www-form-urlencoded/i.test(mimeType)) return this.query(text);
    return this.text(text);
  }

  /** Redact a `a=1&b=2` string. */
  query(qs: string): string {
    const params = new URLSearchParams(qs);
    const out = new URLSearchParams();
    for (const [k, v] of params) {
      out.append(k, isSensitiveName(k) || isPersonalKey(k) ? this.secret(v, "SECRET") : this.text(v));
    }
    return out.toString();
  }

  url(raw: string): string {
    try {
      const u = new URL(raw);
      u.search = u.search ? `?${this.query(u.search.slice(1))}` : "";
      u.hash = "";
      // Path segments can carry tokens/emails (e.g. /users/<uuid>/addresses).
      u.pathname = u.pathname
        .split("/")
        .map((seg) => this.text(decodeURIComponent(seg)))
        .map((seg) => encodeURIComponent(seg).replace(/%5B/g, "[").replace(/%5D/g, "]").replace(/%3A/g, ":"))
        .join("/");
      return u.toString();
    } catch {
      return this.text(raw);
    }
  }

  headers(list: NameValue[] | undefined, tracker = false): NameValue[] | undefined {
    return list?.map((h) => {
      if (isSensitiveName(h.name)) {
        this.stats.headersRedacted++;
        return { ...h, value: this.secret(h.value, "SECRET") };
      }
      if (/^:?path$/i.test(h.name)) return { ...h, value: this.pathAndQuery(h.value, tracker) };
      if (/^(referer|origin|location)$/i.test(h.name)) return { ...h, value: this.url(h.value) };
      return { ...h, value: this.text(h.value) };
    });
  }

  private pathAndQuery(p: string, tracker = false): string {
    const raw = `https://x.invalid${p.startsWith("/") ? "" : "/"}${p}`;
    const full = tracker ? this.trackerUrl(raw) : this.url(raw);
    return full.replace("https://x.invalid", "");
  }

  /** Tracker URL: keep host and path shape, hash every query value. */
  private trackerUrl(raw: string): string {
    try {
      const u = new URL(raw);
      const q = new URLSearchParams();
      for (const [k, v] of new URLSearchParams(u.search)) q.append(k, this.secret(v, "SECRET"));
      const base = this.url(`${u.origin}${u.pathname}`);
      const qs = q.toString();
      return qs ? `${base}?${qs}` : base;
    } catch {
      return this.text(raw);
    }
  }

  cookies(list: NameValue[] | undefined): NameValue[] | undefined {
    return list?.map((c) => {
      this.stats.cookiesRedacted++;
      return { ...c, value: this.secret(c.value, "COOKIE") };
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entry(e: any): any {
    this.stats.entries++;
    const req = e.request ?? {};
    const res = e.response ?? {};
    const out = { ...e };
    const tracker = typeof req.url === "string" && isTrackerUrl(req.url);
    if (tracker) this.stats.trackerEntries++;
    const qv = (name: string, value: string) =>
      tracker || isSensitiveName(name) || isPersonalKey(name) ? this.secret(value, "SECRET") : this.text(value);
    out.request = {
      ...req,
      url: req.url ? (tracker ? this.trackerUrl(req.url) : this.url(req.url)) : req.url,
      headers: this.headers(req.headers, tracker),
      cookies: this.cookies(req.cookies),
      queryString: req.queryString?.map((q: NameValue) => ({ ...q, value: qv(q.name, q.value) })),
    };
    if (req.postData) {
      out.request.postData = {
        ...req.postData,
        text: tracker ? undefined : this.body(req.postData.text, req.postData.mimeType),
        params: tracker
          ? undefined
          : req.postData.params?.map((p: NameValue) => ({ ...p, value: qv(p.name, p.value ?? "") })),
      };
    }
    const content = res.content ?? {};
    let text: string | undefined = tracker ? undefined : content.text;
    if (text !== undefined && content.encoding === "base64") {
      if (this.dropBinary || !/json|text|javascript|html|xml/i.test(content.mimeType ?? "")) {
        this.stats.binaryBodiesDropped++;
        text = undefined;
      } else {
        text = Buffer.from(text, "base64").toString("utf8");
      }
    }
    out.response = {
      ...res,
      headers: this.headers(res.headers),
      cookies: this.cookies(res.cookies),
      redirectURL: res.redirectURL ? this.url(res.redirectURL) : res.redirectURL,
      content: {
        ...content,
        encoding: text === undefined ? undefined : content.encoding === "base64" ? undefined : content.encoding,
        text: this.body(text, content.mimeType),
      },
    };
    // Chrome-specific fields that can embed URLs with tokens / call stacks.
    delete out._initiator;
    delete out.serverIPAddress;
    delete out.connection;
    return out;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  har(har: any): any {
    const log = har?.log;
    if (!log || !Array.isArray(log.entries)) throw new Error("Not a HAR file (missing log.entries)");
    this.collectKnownSecrets(log.entries);
    return {
      log: {
        ...log,
        pages: log.pages?.map((p: { title?: string }) => ({ ...p, title: p.title ? this.url(p.title) : p.title })),
        entries: log.entries.map((e: unknown) => this.entry(e)),
        comment: "Redacted by cines-mx-mcp scripts/redact-har.ts. Values are salted hashes; names and structure are preserved.",
      },
    };
  }
}

export function redactHar(har: unknown, opts: RedactOptions = {}): { har: unknown; stats: RedactStats } {
  const r = new Redactor(opts);
  const out = r.har(har);
  return { har: out, stats: r.stats };
}
