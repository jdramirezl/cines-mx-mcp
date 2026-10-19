#!/usr/bin/env node
/**
 * Developer CLI.
 *
 *   cines probe                 check each Cinépolis operation from this machine
 */
import { GraphQLClient } from "./cinepolis/client.js";
import { CinepolisProvider } from "./cinepolis/provider.js";
import { BILLBOARD_BY_CINEMA, CINEMAS, SEATS, TICKETS, type Operation } from "./cinepolis/queries.js";
import { toErrorShape } from "./errors.js";
import { addDays, localDate } from "./time.js";

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
    case "listings": {
      const cinemaId = rest[0] ?? "cinepolis-parque-toreo-cdmx";
      const tz = "America/Mexico_City";
      const today = localDate(new Date(), tz);
      const date = rest[1] === "tomorrow" ? addDays(today, 1) : rest[1] && rest[1] !== "today" ? rest[1] : today;
      const p = new CinepolisProvider();
      const [movies, showtimes] = await Promise.all([p.getMovies("now-playing", [cinemaId]), p.getShowtimesByCinema(cinemaId)]);
      const title = new Map(movies.map((m) => [m.id, `${m.title} (${m.rating})`]));
      const byMovie = new Map<string, string[]>();
      for (const s of showtimes.filter((x) => x.date === date)) {
        const tag = [s.time, s.language, s.experience ?? s.format, s.availability === "full" ? "AGOTADO" : ""].filter(Boolean).join(" ");
        byMovie.set(s.movieId, [...(byMovie.get(s.movieId) ?? []), tag]);
      }
      console.log(`${cinemaId} ${date}: ${byMovie.size} movies`);
      for (const [id, tags] of byMovie) console.log(`  ${title.get(id) ?? id}\n    ${tags.join(" | ")}`);
      return 0;
    }
    case "login": {
      const { BotBrowser } = await import("./session/browser.js");
      console.log("Abriendo Chrome con el perfil del bot. Inicia sesión en Cinépolis (correo + código) y espera; se cierra solo.");
      const ok = await new BotBrowser().interactiveLogin();
      console.log(ok ? "✅ Sesión de Cinépolis guardada en el perfil del bot." : "❌ No se detectó la sesión (tiempo agotado).");
      return ok ? 0 : 1;
    }
    case "paypal-login": {
      const { BotBrowser } = await import("./session/browser.js");
      console.log("Abriendo PayPal en el perfil del bot. Inicia sesión (marca 'mantener sesión' si aparece) y cierra la ventana al terminar.");
      await new BotBrowser().interactivePaypal();
      console.log("Listo.");
      return 0;
    }
    case "session": {
      const { BotBrowser } = await import("./session/browser.js");
      const { SessionManager } = await import("./session/session.js");
      const s = new SessionManager({ browser: new BotBrowser(), log: (m) => console.log(m) });
      const st = await s.keepAlive();
      console.log(JSON.stringify(st, null, 1));
      return st.state === "valid" || st.state === "expiring" ? 0 : 1;
    }
    case "mailbox-test": {
      const { ImapCodeMailbox, keychainSecret } = await import("./session/mailbox.js");
      const user = process.env.CINES_IMAP_USER;
      if (!user) {
        console.error("Falta CINES_IMAP_USER (en ~/.config/cines-mx/cines.env)");
        return 2;
      }
      const mb = new ImapCodeMailbox({ user, password: async () => process.env.CINES_IMAP_PASSWORD ?? (await keychainSecret("cines-mx-imap", user)), fromContains: process.env.CINES_CODE_SENDER ?? "cinepolis" });
      const hours = Number(rest[0] ?? 48);
      const code = await mb.waitForCode(Date.now() - hours * 3_600_000, 1000);
      console.log(code ? `✅ IMAP OK: encontré un código de Cinépolis de las últimas ${hours} h (no se muestra).` : `IMAP OK, pero no hay códigos de Cinépolis en las últimas ${hours} h.`);
      return 0;
    }
    default:
      console.error(
        "usage: cines probe [cinemaId] | listings [cinemaId] [today|tomorrow|YYYY-MM-DD] | login | paypal-login | session | mailbox-test [hours]",
      );
      return 2;
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (isMain) void import("./server.js").then(({ loadConfigEnv }) => { loadConfigEnv(); return main(process.argv.slice(2)); }).then((c) => (process.exitCode = c));
