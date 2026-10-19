#!/usr/bin/env node
/**
 * Developer CLI.
 *
 *   cines probe                 check each Cinépolis operation from this machine
 */
import { GraphQLClient } from "./cinepolis/client.js";
import { BILLBOARD_BY_CINEMA, CINEMAS, SEATS, TICKETS, type Operation } from "./cinepolis/queries.js";
import { toErrorShape } from "./errors.js";

const TZ = "America/Mexico_City";

interface ProbeRow {
  op: string;
  ok: boolean;
  ms: number;
  note: string;
}

async function timed(op: Operation, f: () => Promise<string>): Promise<ProbeRow> {
  const t0 = Date.now();
  try {
    const note = await f();
    return { op: op.operationName, ok: true, ms: Date.now() - t0, note };
  } catch (e) {
    const { error } = toErrorShape(e);
    return { op: op.operationName, ok: false, ms: Date.now() - t0, note: `${error.code}: ${error.message}` };
  }
}

interface Showtime {
  sessionId: string;
  cinemaVistaId: string;
  datetime: string;
}
interface BillboardData {
  billboardByCinema: { schedules: { dates: { languages: { showtimes: Showtime[] }[] }[] }[] };
}

export async function probe(cinemaId = "cinepolis-parque-toreo-cdmx"): Promise<ProbeRow[]> {
  const c = new GraphQLClient();
  const rows: ProbeRow[] = [];
  rows.push(
    await timed(CINEMAS, async () => {
      const d = await c.call<{ cinemasById: { edges: unknown[] } }>(CINEMAS, { country_id: "MX", cinemas: cinemaId });
      return `${d.cinemasById.edges.length} cinema(s)`;
    }),
  );
  let sample: Showtime | undefined;
  rows.push(
    await timed(BILLBOARD_BY_CINEMA, async () => {
      const d = await c.call<BillboardData>(BILLBOARD_BY_CINEMA, {
        cinemaId,
        countryId: "MX",
        isAbsoluteExperiencePath: true,
        timezone: TZ,
      });
      const all = d.billboardByCinema.schedules.flatMap((s) => s.dates.flatMap((x) => x.languages.flatMap((l) => l.showtimes)));
      sample = all.find((s) => Date.parse(s.datetime) > Date.now() + 3_600_000) ?? all[0];
      return `${d.billboardByCinema.schedules.length} movies, ${all.length} showtimes`;
    }),
  );
  if (sample) {
    const s = sample;
    rows.push(
      await timed(SEATS, async () => {
        const d = await c.call<{ seats: { maxQuantity: number; seatLayoutData: { areas: { rows: { seats: unknown[] }[] }[] } } }>(SEATS, {
          cinemaVistaId: s.cinemaVistaId,
          sessionId: s.sessionId,
          countryId: "MX",
          experience: "TRADICIONAL",
        });
        const seats = d.seats.seatLayoutData.areas.flatMap((a) => a.rows.flatMap((r) => r.seats)).length;
        return `${seats} seats, max ${d.seats.maxQuantity}`;
      }),
    );
    rows.push(
      await timed(TICKETS, async () => {
        const d = await c.call<{ tickets: { tickets: { description: string; priceInCents: number }[] }[] }>(TICKETS, {
          cinemaVistaId: s.cinemaVistaId,
          sessionId: s.sessionId,
          countryId: "MX",
        });
        const t = d.tickets.flatMap((a) => a.tickets);
        return `${t.length} ticket types (${t.map((x) => `${x.description} $${(x.priceInCents / 100).toFixed(2)}`).join(", ")})`;
      }),
    );
  }
  return rows;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "probe": {
      const rows = await probe(rest[0]);
      for (const r of rows) console.log(`${r.ok ? "OK  " : "FAIL"} ${r.op.padEnd(10)} ${String(r.ms).padStart(5)} ms  ${r.note}`);
      return rows.every((r) => r.ok) ? 0 : 1;
    }
    default:
      console.error("usage: cines probe [cinemaId]");
      return 2;
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (isMain) main(process.argv.slice(2)).then((c) => (process.exitCode = c));
