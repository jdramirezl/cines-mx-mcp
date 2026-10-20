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
      const rows = await probe(rest[0] || undefined);
      for (const r of rows) console.log(`${r.ok ? "OK  " : "FAIL"} ${r.op.padEnd(10)} ${String(r.ms).padStart(5)} ms  ${r.note}`);
      return rows.every((r) => r.ok) ? 0 : 1;
    }
    case "listings": {
      const cinemaId = rest[0] || "cinepolis-parque-toreo-cdmx";
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
      const { buildMailbox } = await import("./services.js");
      const s = new SessionManager({
        browser: new BotBrowser(),
        mailbox: buildMailbox(),
        loginEmail: process.env.CINES_LOGIN_EMAIL,
        log: (m) => console.log(m),
      });
      const st = await s.keepAlive();
      console.log(JSON.stringify(st, null, 1));
      return st.state === "valid" || st.state === "expiring" ? 0 : 1;
    }
    case "mailbox-test": {
      const { buildMailbox } = await import("./services.js");
      const mb = buildMailbox();
      if (!mb) {
        console.error("Falta CINES_IMAP_USER (en ~/.config/cines-mx/cines.env)");
        return 2;
      }
      const hours = Number(rest[0] ?? 48);
      const code = await mb.waitForCode(Date.now() - hours * 3_600_000, 1000);
      console.log(code ? `✅ IMAP OK: encontré un código de Cinépolis de las últimas ${hours} h (no se muestra).` : `IMAP OK, pero no hay códigos de Cinépolis en las últimas ${hours} h.`);
      return 0;
    }
    case "arm-payment": {
      const { PaymentArm, ARM_DEFAULT_MIN, ARM_MAX_MIN } = await import("./order/arm.js");
      const { armFile } = await import("./services.js");
      const minutes = Math.min(Number(rest[0] ?? ARM_DEFAULT_MIN) || ARM_DEFAULT_MIN, ARM_MAX_MIN);
      if (!process.stdin.isTTY) {
        console.error("arm-payment requiere una terminal interactiva (no se puede armar desde scripts ni agentes).");
        return 2;
      }
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`Esto habilita UN pago real (tarjeta guardada o PayPal) durante ${minutes} min. Escribe ARMAR para confirmar: `);
      rl.close();
      if (answer.trim() !== "ARMAR") {
        console.log("Cancelado; sigue desarmado.");
        return 1;
      }
      const st = new PaymentArm(armFile()).arm(minutes);
      console.log(`✅ Pago ARMADO hasta ${st.expiresAt} para un solo intento. Desarmar: bin/cinesctl disarm-payment`);
      return 0;
    }
    case "disarm-payment": {
      const { PaymentArm } = await import("./order/arm.js");
      const { armFile } = await import("./services.js");
      new PaymentArm(armFile()).disarm();
      console.log("Pago desarmado.");
      return 0;
    }
    case "hold-status":
    case "release-hold": {
      const { join } = await import("node:path");
      const { HoldService, publicHold } = await import("./cinepolis/orders.js");
      const { PurchaseLedger } = await import("./order/purchase.js");
      const { PaymentArm } = await import("./order/arm.js");
      const { armFile, stateDir } = await import("./services.js");
      const dir = process.env.CINES_STATE_DIR ?? stateDir();
      const holds = new HoldService({ client: new GraphQLClient(), stateFile: join(dir, "holds.json"), log: () => undefined });
      if (cmd === "release-hold") {
        const h = await holds.release(rest[0]);
        console.log(h ? `liberado: ${h.holdId} ${h.seats.join(", ")} (${h.status})` : "No había asientos apartados.");
        return 0;
      }
      const ledger = new PurchaseLedger(join(dir, "purchases.json"));
      const h = holds.active();
      console.log(
        JSON.stringify(
          {
            hold: h ? { ...publicHold(h), secondsLeft: Math.max(0, Math.round((Date.parse(h.expiresAt) - Date.now()) / 1000)) } : null,
            paymentArmed: new PaymentArm(armFile()).status(),
            successfulPurchases: ledger.successes(),
            inFlight: ledger.inFlight() ?? null,
            recent: ledger.recent(3).map((e) => ({ purchaseId: e.purchaseId, at: e.at, total: e.totalMxn, status: e.status, bookingNumber: e.bookingNumber, screenshotPath: e.screenshotPath, error: e.error, dryRun: e.dryRun })),
          },
          null,
          1,
        ),
      );
      return h ? 1 : 0;
    }
    case "preflight": {
      const showtimeId = rest[0];
      if (!showtimeId) {
        console.error("usage: cines preflight <showtimeId> [tickets]");
        return 2;
      }
      const { join } = await import("node:path");
      const { HoldService } = await import("./cinepolis/orders.js");
      const { PurchaseLedger } = await import("./order/purchase.js");
      const { PaymentArm } = await import("./order/arm.js");
      const { armFile, buildMailbox, stateDir } = await import("./services.js");
      const { BotBrowser } = await import("./session/browser.js");
      const { SessionManager } = await import("./session/session.js");
      const { loadProfile } = await import("./profile.js");
      const { runPreflight } = await import("./preflight.js");
      const dir = process.env.CINES_STATE_DIR ?? stateDir();
      const client = new GraphQLClient();
      const browser = new BotBrowser();
      const session = new SessionManager({ browser, mailbox: buildMailbox(), log: () => undefined });
      const holds = new HoldService({ client, stateFile: join(dir, "holds.json"), log: () => undefined });
      const checks = await runPreflight(showtimeId, Number(rest[1] ?? 1), {
        provider: new CinepolisProvider({ client }),
        client,
        profile: loadProfile(),
        holds,
        ledger: new PurchaseLedger(join(dir, "purchases.json")),
        arm: new PaymentArm(armFile()),
        session,
        paypalLoggedIn: () => browser.paypalLoggedIn(),
        savedCards: async () => {
          const { listSavedCards } = await import("./order/card.js");
          const { buyerFromEnv } = await import("./order/paypal.js");
          const { newOrderSessionId } = await import("./order/orderData.js");
          return listSavedCards({ client, accessToken: () => session.getAccessToken({ allowLogin: false }), buyer: buyerFromEnv(), ui: browser }, holds.active()?.priv.orderSessionId ?? newOrderSessionId());
        },
        serverUrl: `http://127.0.0.1:${process.env.CINES_MCP_PORT ?? 8686}/mcp`,
      });
      for (const c of checks) console.log(`${c.info ? "info" : c.ok ? "ok  " : "FAIL"} ${c.name.padEnd(13)} ${c.detail}`);
      const failed = checks.filter((c) => !c.ok && !c.info);
      console.log(failed.length ? `\n❌ ${failed.length} verificación(es) fallaron; no armes el pago.` : "\n✅ Todo listo. Siguiente: bin/cinesctl arm-payment");
      return failed.length ? 1 : 0;
    }
    default:
      console.error(
        "usage: cines probe | listings [cinemaId] [date] | login | paypal-login | session | mailbox-test [hours] | preflight <showtimeId> [tickets] | arm-payment [min] | disarm-payment | hold-status | release-hold [holdId]",
      );
      return 2;
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (isMain) void import("./server.js").then(({ loadConfigEnv }) => { loadConfigEnv(); return main(process.argv.slice(2)); }).then((c) => (process.exitCode = c));
