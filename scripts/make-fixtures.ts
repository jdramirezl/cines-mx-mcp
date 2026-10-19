#!/usr/bin/env -S npx tsx
/**
 * Build small test fixtures from a REDACTED HAR.
 *
 *   npm run fixtures -- ~/cines-capture/cinepolis.com.redacted.har
 *
 * Writes test/fixtures/cinepolis/*.json, trimmed to keep the repo small.
 * Refuses unredacted HARs.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/* eslint-disable @typescript-eslint/no-explicit-any */
const OUT = "test/fixtures/cinepolis";

function main(path: string | undefined): number {
  if (!path) {
    console.error("usage: npm run fixtures -- <redacted.har>");
    return 2;
  }
  const raw = readFileSync(path, "utf8");
  if (!raw.includes("Redacted by cines-mx-mcp")) {
    console.error("refusing: input is not a redacted HAR (run npm run redact first)");
    return 2;
  }
  const har = JSON.parse(raw);
  const found: Record<string, any> = {};
  for (const e of har.log.entries) {
    const url: string = e.request.url;
    if (!url.includes("api-g.cinepolis.com")) continue;
    let body: any;
    let data: any;
    try {
      body = JSON.parse(e.request.postData?.text ?? "null");
      data = JSON.parse(e.response.content?.text ?? "null")?.data;
    } catch {
      continue;
    }
    if (!body || !data) continue;
    const v = body.variables ?? {};
    const op = body.operationName;
    if (op === "Cinemas") found.cinemas ??= data;
    else if (op === "Movies" && data.movies && !found.movies) found.movies = { variables: v, data };
    else if (op === "Movies" && data.movie) found.movie ??= { variables: v, data };
    else if (op === "Billboard" && data.billboardByCinema) found.billboardByCinema ??= { variables: v, data };
    else if (op === "Billboard" && data.billboard) found.billboardByMovie ??= { variables: v, data };
    else if (op === "Seats" && !v.userSessionId) found.seats ??= { variables: v, data };
    else if (op === "Tickets" && !v.userSessionId) found.tickets ??= { variables: v, data };
    else if (op === "Tickets" && v.userSessionId) found.memberTickets ??= { variables: v, data };
    else if (op === "Order") found.order ??= { variables: v, data };
  }

  // Trim billboards to the first 3 dates.
  for (const k of ["billboardByCinema", "billboardByMovie"] as const) {
    if (!found[k]) continue;
    const bb = found[k].data.billboardByCinema ?? found[k].data.billboard;
    const keep = new Set<string>(bb.dates.slice(0, 3));
    bb.dates = bb.dates.slice(0, 3);
    for (const s of bb.schedules) s.dates = s.dates.filter((d: any) => keep.has(d.date));
    bb.schedules = bb.schedules.filter((s: any) => s.dates.length);
  }
  if (found.movies) {
    const edges = found.movies.data.movies.edges as any[];
    const pick = (cat: string, n: number) => edges.filter((x) => x.node.categories.includes(cat)).slice(0, n);
    const chosen = new Map<string, any>();
    for (const x of [...pick("now-playing", 8), ...pick("pre-sale", 3), ...pick("coming-soon", 4)]) chosen.set(x.node.id, x);
    for (const x of chosen.values()) {
      x.node.synopsis = String(x.node.synopsis ?? "").slice(0, 160);
      x.node.media = (x.node.media ?? []).slice(0, 1);
      x.node.cinemas = (x.node.cinemas ?? []).slice(0, 10);
    }
    found.movies.data.movies.edges = [...chosen.values()];
  }
  if (found.movie) {
    const m = found.movie.data.movie;
    m.cast = { actors: (m.cast?.actors ?? []).slice(0, 2), directors: (m.cast?.directors ?? []).slice(0, 1), producers: [] };
    m.cinemas = (m.cinemas ?? []).slice(0, 10);
  }

  mkdirSync(OUT, { recursive: true });
  for (const [name, value] of Object.entries(found)) {
    const file = join(OUT, `${name}.json`);
    writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);
    console.log(`wrote ${file}`);
  }
  return 0;
}

process.exitCode = main(process.argv[2]);
