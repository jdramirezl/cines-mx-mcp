/**
 * Minimal HTTPS transport.
 *
 * cinepolis.com sits behind Cloudflare bot rules that reject Node's default
 * fetch (undici) fingerprint. Measured from a residential connection
 * (2026-10-19):
 *   - api-g.cinepolis.com accepts plain HTTP/1.1 when `Host` is the first header;
 *   - the static/micro-frontend hosts additionally require TLS 1.2 with ALPN http/1.1;
 *   - HTTP/2 and Node's default header order (Host last) get 403.
 * This transport satisfies all of them: one keep-alive agent pinned to TLS 1.2,
 * ALPN http/1.1, and headers written in browser order with Host first.
 *
 * This is not an attempt to defeat a challenge: there is no captcha in the
 * flow; it just presents a conventional HTTP/1.1 client.
 */
import https from "node:https";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";

export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 4,
  maxVersion: "TLSv1.2",
  ALPNProtocols: ["http/1.1"],
});

function decode(buf: Buffer, encoding: string | undefined): string {
  switch ((encoding ?? "").toLowerCase()) {
    case "gzip":
      return gunzipSync(buf).toString("utf8");
    case "deflate":
      return inflateSync(buf).toString("utf8");
    case "br":
      return brotliDecompressSync(buf).toString("utf8");
    default:
      return buf.toString("utf8");
  }
}

/** Order headers like a browser: Host first, then UA/Accept, then the rest. */
export function orderHeaders(url: URL, extra: Record<string, string> = {}): Record<string, string> {
  const lower = new Map(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), [k, v] as const]));
  const take = (name: string, fallback?: string): [string, string] | undefined => {
    const hit = lower.get(name);
    lower.delete(name);
    if (hit) return [hit[0], hit[1]];
    return fallback === undefined ? undefined : [name.replace(/(^|-)\w/g, (s) => s.toUpperCase()), fallback];
  };
  const out: [string, string][] = [];
  out.push(["Host", url.host]);
  lower.delete("host");
  for (const [name, fb] of [
    ["user-agent", BROWSER_UA],
    ["accept", "*/*"],
    ["accept-language", "es-MX,es;q=0.9"],
    ["accept-encoding", "gzip, deflate, br"],
  ] as const) {
    const h = take(name, fb);
    if (h) out.push(h);
  }
  for (const [, [k, v]] of lower) out.push([k, v]);
  return Object.fromEntries(out);
}

export const httpsTransport: Transport = (req) =>
  new Promise((resolve, reject) => {
    const url = new URL(req.url);
    const body = req.body;
    const headers = orderHeaders(url, {
      ...(req.headers ?? {}),
      ...(body !== undefined ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
    });
    const r = https.request(
      url,
      { method: req.method ?? (body === undefined ? "GET" : "POST"), agent, headers, timeout: req.timeoutMs ?? 20_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => {
          try {
            const text = decode(Buffer.concat(chunks), res.headers["content-encoding"] as string | undefined);
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text });
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", reject);
      },
    );
    r.on("timeout", () => r.destroy(new Error(`timeout after ${req.timeoutMs ?? 20_000} ms`)));
    r.on("error", reject);
    r.end(body);
  });
