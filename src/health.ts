/**
 * Health check for the launchd service. Run periodically by
 * com.jdrami.cines-health; alerts on Telegram only when the state changes.
 *
 *   node dist/health.js [--quiet] [--no-alert]
 *
 * Checks: local /healthz, MCP tools/list, and one upstream Cinépolis read
 * (cinemas + billboard for the home cinema). Telegram credentials come from
 * ~/.config/cines-mx/alert.env (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, 0600);
 * the token is sent in the request body, never in argv or logs.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { CinepolisProvider } from "./cinepolis/provider.js";
import { toErrorShape } from "./errors.js";
import { httpsTransport, type Transport } from "./http/transport.js";
import { DEFAULT_PROFILE } from "./profile.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HealthDeps {
  mcpUrl: string;
  fetchLocal?: typeof fetch;
  upstream?: () => Promise<string>;
}

export async function runChecks(deps: HealthDeps): Promise<CheckResult[]> {
  const f = deps.fetchLocal ?? fetch;
  const out: CheckResult[] = [];
  const base = deps.mcpUrl.replace(/\/mcp$/, "");
  try {
    const r = await f(`${base}/healthz`, { signal: AbortSignal.timeout(5000) });
    out.push({ name: "server", ok: r.ok, detail: r.ok ? "up" : `HTTP ${r.status}` });
  } catch (e) {
    out.push({ name: "server", ok: false, detail: `no response on ${base} (${(e as Error).message})` });
  }
  if (out[0]?.ok) {
    try {
      const r = await f(deps.mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        signal: AbortSignal.timeout(10_000),
      });
      const j = (await r.json()) as { result?: { tools?: unknown[] } };
      const n = j.result?.tools?.length ?? 0;
      out.push({ name: "mcp", ok: n > 0, detail: n > 0 ? `${n} tools` : `HTTP ${r.status}, no tools` });
    } catch (e) {
      out.push({ name: "mcp", ok: false, detail: (e as Error).message });
    }
  }
  try {
    const note = await (deps.upstream ?? defaultUpstream)();
    out.push({ name: "cinepolis", ok: true, detail: note });
  } catch (e) {
    const { error } = toErrorShape(e);
    out.push({ name: "cinepolis", ok: false, detail: `${error.code}: ${error.message}` });
  }
  return out;
}

async function defaultUpstream(): Promise<string> {
  const p = new CinepolisProvider();
  const home = DEFAULT_PROFILE.cinemas[0]!.id;
  const [c, s] = await Promise.all([p.getCinemas([home]), p.getShowtimesByCinema(home)]);
  return `${c.length} cinema, ${s.length} showtimes`;
}

export function summarize(results: CheckResult[]): string {
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  return failed.length ? `fail:${failed.join(",")}` : "ok";
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export function alertText(state: string, results: CheckResult[], host = hostname()): string {
  if (state === "ok") return `🟢 Cines MCP healthy again on ${host}`;
  const lines = results.filter((r) => !r.ok).map((r) => `- ${r.name}: ${r.detail}`);
  const hint = results.some((r) => r.name === "server" && !r.ok)
    ? "→ run `cinesctl restart`; logs in ~/Library/Logs/cines-mx"
    : results.some((r) => r.name === "cinepolis" && /SCHEMA_CHANGED/.test(r.detail))
      ? "→ Cinépolis changed its site/API; the MCP needs an update"
      : results.some((r) => r.name === "cinepolis" && /BLOCKED/.test(r.detail))
        ? "→ Cinépolis is blocking requests from this Mac; wait and retry"
        : "";
  return [`🔴 Cines MCP unhealthy on ${host}`, ...lines, hint].filter(Boolean).join("\n");
}

export async function sendTelegram(token: string, chatId: string, text: string, transport: Transport = httpsTransport): Promise<boolean> {
  const r = await transport({
    url: `https://api.telegram.org/bot${token}/sendMessage`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  return r.status === 200;
}

export interface Paths {
  stateFile: string;
  alertEnv: string;
}

export function defaultPaths(home = homedir()): Paths {
  return {
    stateFile: join(home, "Library", "Application Support", "cines-mx", "health.state"),
    alertEnv: join(home, ".config", "cines-mx", "alert.env"),
  };
}

export async function main(argv: string[], env = process.env, paths = defaultPaths()): Promise<number> {
  const quiet = argv.includes("--quiet");
  const port = env.CINES_MCP_PORT ?? "8686";
  const results = await runChecks({ mcpUrl: `http://127.0.0.1:${port}/mcp` });
  const state = summarize(results);
  const prev = existsSync(paths.stateFile) ? readFileSync(paths.stateFile, "utf8").trim() : "";
  mkdirSync(dirname(paths.stateFile), { recursive: true });
  writeFileSync(paths.stateFile, `${state}\n`);
  if (!quiet) {
    console.log(`health: ${state}`);
    for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.detail}`);
  }
  const changed = state !== prev && !(prev === "" && state === "ok");
  if (!changed) {
    if (!quiet) console.log("unchanged since last run; no alert sent");
  } else if (!argv.includes("--no-alert")) {
    if (!existsSync(paths.alertEnv)) {
      console.error(`no ${paths.alertEnv}; alert not sent`);
    } else {
      const mode = statSync(paths.alertEnv).mode & 0o077;
      if (mode) console.error(`warning: ${paths.alertEnv} is readable by others; chmod 600 it`);
      const e = parseEnvFile(readFileSync(paths.alertEnv, "utf8"));
      if (e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHAT_ID) {
        const sent = await sendTelegram(e.TELEGRAM_BOT_TOKEN, e.TELEGRAM_CHAT_ID, alertText(state, results)).catch(() => false);
        console.log(sent ? "alert sent" : "alert FAILED to send");
      } else console.error("alert.env missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID");
    }
  }
  return state === "ok" ? 0 : 1;
}

const isMain = process.argv[1] && /health\.(js|ts)$/.test(process.argv[1]);
if (isMain) main(process.argv.slice(2)).then((c) => (process.exitCode = c));
