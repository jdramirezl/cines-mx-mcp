import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alertText, main, parseEnvFile, runChecks, sendTelegram, summarize, type CheckResult } from "../src/health.js";
import type { HttpRequest } from "../src/http/transport.js";
import { startServer } from "../src/server.js";
import { CinepolisProvider } from "../src/cinepolis/provider.js";

const CTL = new URL("../bin/cinesctl", import.meta.url).pathname;

describe("cinesctl", () => {
  const home = mkdtempSync(join(tmpdir(), "cines-home-"));
  const env = { ...process.env, CINES_HOME: home, NODE_BIN: process.execPath, CINES_MCP_PORT: "8699" };

  it("renders both plists with loopback host, port, node and absolute paths", () => {
    const out = execFileSync("bash", [CTL, "render"], { env, encoding: "utf8" });
    expect(out).toContain("<string>com.jdrami.cines-mcp</string>");
    expect(out).toContain("<string>com.jdrami.cines-health</string>");
    expect(out).toContain("<key>CINES_MCP_HOST</key><string>127.0.0.1</string>");
    expect(out).toContain("<string>8699</string>");
    expect(out).toContain(process.execPath);
    expect(out).toContain(`${home}/Library/Application Support/cines-mx/app/dist/server.js`);
    expect(out).not.toMatch(/@[A-Z_]+@/);
  });

  it("rendered plists pass plutil -lint (macOS)", () => {
    if (process.platform !== "darwin") return;
    const out = execFileSync("bash", [CTL, "render"], { env, encoding: "utf8" });
    const parts = out.split(/(?=<\?xml)/);
    for (const [i, p] of parts.entries()) {
      const f = join(home, `p${i}.plist`);
      writeFileSync(f, p);
      expect(spawnSync("plutil", ["-lint", "-s", f]).status).toBe(0);
    }
  });

  it("install --dry-run changes nothing and shows the plan", () => {
    const r = spawnSync("bash", [CTL, "install", "--dry-run"], { env, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[dry-run\] launchctl bootstrap/);
    expect(r.stdout).toMatch(/\[dry-run\] write .*com\.jdrami\.cines-mcp\.plist/);
    expect(spawnSync("ls", [join(home, "Library", "LaunchAgents")]).status).not.toBe(0);
  });

  it("rejects an old Node", () => {
    const fake = join(home, "node16");
    writeFileSync(fake, "#!/bin/sh\necho 16.20.0\n", { mode: 0o755 });
    const r = spawnSync("bash", [CTL, "render"], { env: { ...env, NODE_BIN: fake }, encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/22\.13/);
  });

  it("prints usage on unknown commands", () => {
    const r = spawnSync("bash", [CTL, "bogus"], { env, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/cinesctl install/);
  });
});

describe("health", () => {
  it("parses env files", () => {
    expect(parseEnvFile("# c\nTELEGRAM_BOT_TOKEN='abc'\nexport TELEGRAM_CHAT_ID=42\n")).toEqual({ TELEGRAM_BOT_TOKEN: "abc", TELEGRAM_CHAT_ID: "42" });
  });

  it("summarizes and words alerts with hints", () => {
    const res: CheckResult[] = [
      { name: "server", ok: true, detail: "up" },
      { name: "cinepolis", ok: false, detail: "CINES_SCHEMA_CHANGED: x" },
    ];
    expect(summarize(res)).toBe("fail:cinepolis");
    expect(alertText("fail:cinepolis", res, "mac")).toMatch(/🔴[\s\S]*cinepolis: CINES_SCHEMA_CHANGED[\s\S]*needs an update/);
    expect(alertText("ok", res, "mac")).toBe("🟢 Cines MCP healthy again on mac");
  });

  it("checks a running server end to end", async () => {
    const srv = await startServer({ port: 0, provider: new CinepolisProvider() });
    try {
      const r = await runChecks({ mcpUrl: srv.url, upstream: async () => "fake upstream ok" });
      expect(r.map((x) => [x.name, x.ok])).toEqual([["server", true], ["mcp", true], ["cinepolis", true]]);
      expect(r[1]!.detail).toMatch(/\d+ tools/);
    } finally {
      await srv.close();
    }
  });

  it("reports a dead server", async () => {
    const r = await runChecks({ mcpUrl: "http://127.0.0.1:9/mcp", upstream: async () => "x" });
    expect(r[0]).toMatchObject({ name: "server", ok: false });
    expect(summarize(r)).toBe("fail:server");
  });

  it("sends the token in the URL path only to Telegram, chat id in the body", async () => {
    const seen: HttpRequest[] = [];
    const ok = await sendTelegram("TKN", "42", "hi", async (r) => {
      seen.push(r);
      return { status: 200, headers: {}, text: "{}" };
    });
    expect(ok).toBe(true);
    expect(seen[0]!.url).toBe("https://api.telegram.org/botTKN/sendMessage");
    expect(JSON.parse(seen[0]!.body!)).toMatchObject({ chat_id: "42", text: "hi" });
  });

  it("writes state and only alerts on change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cines-health-"));
    const paths = { stateFile: join(dir, "s", "health.state"), alertEnv: join(dir, "none.env") };
    const env = { CINES_MCP_PORT: "9" };
    const log = console.log;
    const err = console.error;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    console.error = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      expect(await main(["--no-alert"], env, paths)).toBe(1);
      expect(readFileSync(paths.stateFile, "utf8")).toMatch(/^fail:server/);
      lines.length = 0;
      await main([], env, paths);
      expect(lines.join("\n")).toMatch(/unchanged since last run/);
    } finally {
      console.log = log;
      console.error = err;
    }
  }, 30_000);
});
