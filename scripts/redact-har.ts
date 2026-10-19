#!/usr/bin/env -S npx tsx
/**
 * Redact a HAR capture so it can be analyzed or turned into fixtures.
 *
 *   npm run redact -- <input.har> [output.har]
 *
 * Default output: <input dir>/<name>.redacted.har (next to the input, i.e.
 * OUTSIDE the repo when the capture lives in ~/cines-capture). Refuses to write
 * inside a git work tree unless --allow-repo-output is given.
 *
 * Extra literals to scrub (e.g. the account holder's name) come from the
 * CINES_REDACT_LITERALS env var (comma-separated), so they are never committed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { redactHar } from "../src/safety/redact.js";
import { scanText } from "../src/safety/scan.js";

function insideGitRepo(dir: string): boolean {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function main(argv: string[]): number {
  const args = argv.filter((a) => !a.startsWith("--"));
  const allowRepo = argv.includes("--allow-repo-output");
  const input = args[0];
  if (!input) {
    console.error("usage: npm run redact -- <input.har> [output.har] [--allow-repo-output]");
    return 2;
  }
  const inPath = resolve(input);
  const outPath = resolve(args[1] ?? join(dirname(inPath), `${basename(inPath, extname(inPath))}.redacted.har`));
  if (!allowRepo && insideGitRepo(dirname(outPath))) {
    console.error(`refusing to write ${outPath}: it is inside a git work tree (use --allow-repo-output for fixtures)`);
    return 2;
  }
  const literals = (process.env.CINES_REDACT_LITERALS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const raw = JSON.parse(readFileSync(inPath, "utf8"));
  const { har, stats } = redactHar(raw, { literals });
  const text = JSON.stringify(har, null, 1);
  // Self-check: the output must pass the same scanner used before commits.
  const leftovers = scanText(outPath, text, { literals }).filter((f) => f.kind !== "unredacted-har-content");
  writeFileSync(outPath, text, { mode: 0o600 });
  console.log(`redacted ${stats.entries} entries -> ${outPath}`);
  console.log(
    `  headers=${stats.headersRedacted} cookies=${stats.cookiesRedacted} bodies=${stats.bodiesScrubbed} binaryDropped=${stats.binaryBodiesDropped}`,
  );
  if (leftovers.length) {
    console.error(`WARNING: ${leftovers.length} possible secrets remain (kinds: ${[...new Set(leftovers.map((f) => f.kind))].join(", ")})`);
    for (const f of leftovers.slice(0, 20)) console.error(`  line ${f.line}: ${f.kind} ${f.excerpt}`);
    return 1;
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
