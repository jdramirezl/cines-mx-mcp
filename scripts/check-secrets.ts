#!/usr/bin/env -S npx tsx
/**
 * Scan every file git would commit (tracked + untracked-not-ignored, or the
 * paths given as arguments) for secrets and personal data. Exit 1 on findings.
 *
 * Add private literals (live x-apikey, account holder's name) via the
 * CINES_SECRET_LITERALS env var (comma-separated); they are never stored.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isProbablyBinary, scanPathPolicy, scanText, type Finding } from "../src/safety/scan.js";

function listFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

function main(argv: string[]): number {
  const files = argv.length ? argv : listFiles();
  const literals = (process.env.CINES_SECRET_LITERALS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const findings: Finding[] = [];
  for (const file of files) {
    if (!existsSync(file) || statSync(file).isDirectory()) continue;
    findings.push(...scanPathPolicy(file));
    const buf = readFileSync(file);
    if (isProbablyBinary(buf)) continue;
    findings.push(...scanText(file, buf.toString("utf8"), { literals }));
  }
  if (findings.length) {
    console.error(`check-secrets: ${findings.length} finding(s)`);
    for (const f of findings) console.error(`  ${f.file}:${f.line} ${f.kind} ${f.excerpt}`);
    return 1;
  }
  console.log(`check-secrets: ${files.length} files clean`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
