/**
 * The public `x-apikey` that cinepolis.com's own front-end sends to
 * api-g.cinepolis.com. It is embedded in the site's JavaScript, but it is still
 * never committed here: it comes from `CINEPOLIS_API_KEY` or is discovered at
 * runtime from the schedules micro-frontend and cached in memory.
 */
import { CinesError } from "../errors.js";
import type { Transport } from "../http/transport.js";

export const SCHEDULES_MF = "https://schedules-mf.cinepolis.com/_next/static/chunks/remoteEntry.js";
const KEY_RE = /\bAPI_KEY\s*:\s*"([A-Za-z0-9]{32,64})"/;

/** From remoteEntry.js, list candidate chunk URLs (id -> hash map emitted by webpack). */
export function chunkUrls(remoteEntry: string, base = SCHEDULES_MF): string[] {
  const root = base.replace(/static\/chunks\/remoteEntry\.js$/, "");
  const names: Record<string, string> = {};
  const named = /\(\(\{([^}]*)\}\)\[e\]\|\|e\)\+"\."\+\(\{([^}]*)\}\)\[e\]/.exec(remoteEntry);
  if (!named) return [];
  for (const m of named[1]!.matchAll(/(\d+):"([^"]+)"/g)) names[m[1]!] = m[2]!;
  const out: string[] = [];
  for (const m of named[2]!.matchAll(/(\d+):"([0-9a-f]{8,20})"/g)) {
    const id = m[1]!;
    out.push(`${root}static/chunks/${names[id] ?? id}.${m[2]!}.js`);
  }
  return out;
}

export function findKey(js: string): string | undefined {
  return KEY_RE.exec(js)?.[1];
}

export class ApiKeyProvider {
  private cached?: string;
  private discovering?: Promise<string>;

  constructor(
    private readonly transport: Transport,
    private readonly envKey: string | undefined = process.env.CINEPOLIS_API_KEY,
    private readonly maxChunks = 40,
  ) {}

  async get(): Promise<string> {
    if (this.envKey) return this.envKey;
    if (this.cached) return this.cached;
    this.discovering ??= this.discover().finally(() => (this.discovering = undefined));
    return this.discovering;
  }

  /** Forget a key that the API rejected so the next call re-discovers it. */
  invalidate(): void {
    this.cached = undefined;
  }

  private async discover(): Promise<string> {
    const entry = await this.transport({ url: SCHEDULES_MF, headers: { Referer: "https://cinepolis.com/" } });
    if (entry.status !== 200) {
      throw new CinesError("CINES_BLOCKED", "Could not load the Cinépolis site script to read its API key", { detail: `HTTP ${entry.status}` });
    }
    const direct = findKey(entry.text);
    if (direct) return (this.cached = direct);
    const urls = chunkUrls(entry.text).slice(0, this.maxChunks);
    if (urls.length === 0) {
      throw new CinesError("CINES_SCHEMA_CHANGED", "Cinépolis site script layout changed; set CINEPOLIS_API_KEY");
    }
    for (const url of urls) {
      const res = await this.transport({ url, headers: { Referer: "https://cinepolis.com/" } });
      if (res.status !== 200) continue;
      const key = findKey(res.text);
      if (key) return (this.cached = key);
    }
    throw new CinesError("CINES_SCHEMA_CHANGED", "API key not found in the Cinépolis site scripts; set CINEPOLIS_API_KEY");
  }
}
