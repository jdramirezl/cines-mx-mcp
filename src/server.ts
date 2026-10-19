/**
 * cines-mx-mcp server: MCP over Streamable HTTP, loopback only.
 *
 *   CINES_MCP_PORT (default 8686)   CINES_MCP_HOST must be 127.0.0.1 / ::1 / localhost
 *
 * Endpoints:
 *   POST /mcp            MCP (stateless, JSON responses)
 *   GET  /healthz        liveness + upstream probe summary
 *   GET  /images/<id>    short-lived PNGs produced by seat tools
 *
 * No authentication by design: the socket is bound to the loopback interface
 * and requests whose Host header is not loopback are rejected (DNS rebinding).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CinepolisProvider } from "./cinepolis/provider.js";
import { ImageStore } from "./images.js";
import { loadProfile, type Profile } from "./profile.js";
import type { CinemaProvider } from "./provider.js";
import { registerReadTools, type ToolContext } from "./tools.js";

export const VERSION = "0.1.0";
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export interface ServerOptions {
  host?: string;
  port?: number;
  provider?: CinemaProvider;
  profile?: Profile;
  images?: ImageStore;
  now?: () => Date;
}

export function assertLoopback(host: string): void {
  if (!LOOPBACK.has(host)) throw new Error(`refusing to bind ${host}: cines-mx-mcp only listens on loopback (127.0.0.1)`);
}

export function buildMcpServer(ctx: ToolContext & { images: ImageStore; baseUrl: string }): McpServer {
  const server = new McpServer({ name: "cines-mx-mcp", version: VERSION });
  registerReadTools(server, ctx);
  return server;
}

function hostAllowed(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return LOOPBACK.has(host);
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(payload);
}

export async function startServer(opts: ServerOptions = {}): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const host = opts.host ?? process.env.CINES_MCP_HOST ?? "127.0.0.1";
  assertLoopback(host);
  const port = opts.port ?? Number(process.env.CINES_MCP_PORT ?? 8686);
  const images = opts.images ?? new ImageStore();
  const ctx: ToolContext = {
    provider: opts.provider ?? new CinepolisProvider(),
    profile: opts.profile ?? loadProfile(),
    now: opts.now,
  };

  let baseUrl = "";
  const http = createServer(async (req, res) => {
    try {
      if (!hostAllowed(req)) return send(res, 403, { error: { code: "CINES_BAD_REQUEST", message: "non-loopback Host", retryable: false } });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/healthz") {
        return send(res, 200, { ok: true, name: "cines-mx-mcp", version: VERSION });
      }
      if (req.method === "GET" && url.pathname.startsWith("/images/")) {
        const img = images.get(url.pathname.slice("/images/".length).replace(/\.png$/, ""));
        return img ? send(res, 200, img, "image/png") : send(res, 404, { error: { code: "CINES_NOT_FOUND", message: "image expired", retryable: false } });
      }
      if (url.pathname !== "/mcp") return send(res, 404, { error: { code: "CINES_NOT_FOUND", message: "not found", retryable: false } });
      if (req.method !== "POST") return send(res, 405, { error: { code: "CINES_BAD_REQUEST", message: "use POST", retryable: false } });
      const body = await readBody(req);
      // Stateless: a fresh server + transport per request (SDK-recommended pattern).
      const mcp = buildMcpServer({ ...ctx, images, baseUrl });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) send(res, 400, { error: { code: "CINES_BAD_REQUEST", message: (e as Error).message, retryable: false } });
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => resolve());
  });
  const addr = http.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  baseUrl = `http://${host.includes(":") ? `[${host}]` : host}:${actualPort}`;
  // Warm the catalog in the background so the first real question is fast.
  if (opts.provider === undefined && process.env.CINES_NO_WARMUP !== "1") {
    const p = ctx.provider as CinepolisProvider;
    void p.getCatalog(ctx.profile.cinemas.map((c) => c.id)).catch((e: unknown) => console.error(`warm-up failed: ${(e as Error).message}`));
  }
  return {
    server: http,
    url: `${baseUrl}/mcp`,
    close: () => new Promise((r) => http.close(() => r())),
  };
}

const isMain = process.argv[1] && /server\.(js|ts)$/.test(process.argv[1]);
if (isMain) {
  startServer()
    .then(({ url }) => console.log(`cines-mx-mcp ${VERSION} listening on ${url}`))
    .catch((e: unknown) => {
      console.error(String((e as Error).message ?? e));
      process.exit(1);
    });
}
