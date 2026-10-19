/**
 * MCP read tools. Each returns compact JSON (one text block) or the shared
 * error shape with isError=true.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Cinema, Movie, Showtime } from "./domain.js";
import { EXPERIENCE_LABEL } from "./domain.js";
import { CinesError, toErrorShape } from "./errors.js";
import type { Profile } from "./profile.js";
import type { CinemaProvider, TicketType } from "./provider.js";
import { pickBestAndAlternatives, rankShowtimes, type Scored, type TimeWindow } from "./ranking.js";
import { matchMovies, norm, resolveCinemas, resolveDate } from "./resolve.js";
import { addDays, localDate } from "./time.js";

export interface ToolContext {
  provider: CinemaProvider & { getCatalog?(ids: string[]): Promise<Movie[]> };
  profile: Profile;
  now?: () => Date;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function fail(err: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(toErrorShape(err)) }], isError: true };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function cinemaLabel(ctx: ToolContext, id: string): string {
  return ctx.profile.cinemas.find((c) => c.id === id)?.label ?? id;
}

function compactShowtime(ctx: ToolContext, s: Showtime) {
  return {
    showtimeId: s.id,
    cinema: cinemaLabel(ctx, s.cinemaId),
    date: s.date,
    time: s.time,
    lang: s.language,
    format: s.experience ? EXPERIENCE_LABEL[s.experience] ?? s.experience : s.format,
    screen: s.screen,
    availability: s.availability,
  };
}

function movieSummary(m: Movie | undefined, id: string) {
  if (!m) return { id };
  return {
    id: m.id,
    title: m.title,
    original: m.originalTitle !== m.title ? m.originalTitle : undefined,
    rating: m.rating,
    minutes: m.durationMin,
    genres: m.genres.slice(0, 3),
    release: m.releaseDate,
    presale: m.presale || undefined,
  };
}

async function catalog(ctx: ToolContext, cinemaIds: string[]): Promise<Movie[]> {
  if (ctx.provider.getCatalog) return ctx.provider.getCatalog(cinemaIds);
  const [a, b] = await Promise.all([ctx.provider.getMovies("now-playing", cinemaIds), ctx.provider.getMovies("pre-sale", cinemaIds)]);
  return [...new Map([...a, ...b].map((m) => [m.id, m])).values()];
}

async function showtimesFor(ctx: ToolContext, cinemaIds: string[]): Promise<Showtime[]> {
  const lists = await Promise.all(cinemaIds.map((id) => ctx.provider.getShowtimesByCinema(id)));
  return lists.flat();
}

async function resolveMovie(ctx: ToolContext, query: string, cinemaIds: string[]): Promise<Movie> {
  const movies = await catalog(ctx, cinemaIds);
  const hits = matchMovies(query, movies);
  if (!hits.length) {
    const sample = movies.slice(0, 12).map((m) => m.title).join(", ");
    throw new CinesError("CINES_NOT_FOUND", `No encontré "${query}" en tus cines. En cartelera: ${sample}…`);
  }
  const top = hits[0]!;
  if (hits.length >= 4 && matchMovies(query, [top]).length && norm(top.title) !== norm(query) && query.trim().length < 4) {
    // Very short query matching many titles: let the model ask.
    throw new CinesError("CINES_BAD_REQUEST", `"${query}" es ambiguo: ${hits.slice(0, 5).map((m) => m.title).join(" | ")}`);
  }
  return top;
}

/** Ticket advice for one showtime: default type price, cheaper promos, Club note. */
export async function ticketAdvice(ctx: ToolContext, s: Showtime, quantity: number) {
  let tickets: TicketType[];
  try {
    tickets = await ctx.provider.getTickets({ cinemaVistaId: s.cinemaVistaId, sessionId: s.sessionId });
  } catch {
    return { note: "Precios no disponibles ahora." };
  }
  const wanted = ctx.profile.preferences.defaultTicketType.toLowerCase();
  const def = tickets.find((t) => t.description.toLowerCase() === wanted) ?? tickets.find((t) => /general|adulto/i.test(t.description));
  const cheaper = def
    ? tickets
        .filter((t) => t.priceMxn < def.priceMxn && !/niñ|nin|edad|senior|estud|discap/i.test(t.description))
        .map((t) => ({ type: t.description, priceMxn: t.priceMxn }))
    : [];
  return {
    defaultType: def?.description,
    unitMxn: def?.priceMxn,
    totalMxn: def ? Math.round(def.priceMxn * quantity * 100) / 100 : undefined,
    cheaperPromos: cheaper.length ? cheaper : undefined,
    otherTypes: tickets.filter((t) => t !== def).map((t) => `${t.description} $${t.priceMxn}`),
  };
}

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  const now = () => ctx.now?.() ?? new Date();
  const tz = ctx.profile.timezone;

  server.registerTool(
    "cines_list_cinemas",
    {
      title: "List my cinemas",
      description: "List the user's Cinépolis cinemas (regular and VIP) with distance from home and seating rules.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const live = await ctx.provider.getCinemas(ctx.profile.cinemas.map((c) => c.id));
        const byId = new Map(live.map((c) => [c.id, c]));
        return ok({
          cinemas: ctx.profile.cinemas.map((c) => ({
            id: c.id,
            name: c.label,
            distanceKm: c.distanceKm,
            vip: byId.get(c.id)?.isVip ?? c.vip,
            available: byId.has(c.id),
          })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cines_listings",
    {
      title: "Listings for a cinema and date",
      description:
        "Movies and showtimes at one or more of the user's cinemas for a date. `cinema` accepts names like 'toreo', 'toreo vip', 'miyana'. `date` accepts YYYY-MM-DD, 'hoy', 'mañana' or a weekday. Languages: SUB=subtitulada, ESP=doblada.",
      inputSchema: {
        cinema: z.string().optional().describe("Cinema name or id; default: home cinema (Parque Toreo)"),
        date: z.string().optional().describe("YYYY-MM-DD, hoy, mañana, or weekday; default today"),
      },
      annotations: READ_ONLY,
    },
    async ({ cinema, date }) => {
      try {
        const ids = resolveCinemas(cinema ?? ctx.profile.cinemas[0]!.id, ctx.profile);
        const day = resolveDate(date, tz, now());
        const [movies, showtimes] = await Promise.all([catalog(ctx, ids), showtimesFor(ctx, ids)]);
        const titles = new Map(movies.map((m) => [m.id, m]));
        const cutoff = now().getTime();
        const byMovie = new Map<string, Showtime[]>();
        for (const s of showtimes) {
          if (s.date !== day || Date.parse(s.startsAt) < cutoff) continue;
          byMovie.set(s.movieId, [...(byMovie.get(s.movieId) ?? []), s]);
        }
        return ok({
          date: day,
          cinemas: ids.map((id) => cinemaLabel(ctx, id)),
          movies: [...byMovie].map(([id, list]) => ({
            ...movieSummary(titles.get(id), id),
            showtimes: list.map((s) => `${s.time} ${s.language} ${s.experience ?? s.format}${ids.length > 1 ? ` @${cinemaLabel(ctx, s.cinemaId)}` : ""}${s.availability === "half_full" ? " (llenándose)" : ""}`),
          })),
          note: byMovie.size ? undefined : "No hay funciones restantes para esa fecha.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cines_find_movie",
    {
      title: "Which of my cinemas show a movie",
      description: "Find a movie by (partial) title and list which of the user's cinemas show it and on which dates.",
      inputSchema: { movie: z.string().describe("Movie title, partial title, or id") },
      annotations: READ_ONLY,
    },
    async ({ movie }) => {
      try {
        const ids = resolveCinemas(undefined, ctx.profile);
        const m = await resolveMovie(ctx, movie, ids);
        const st = await ctx.provider.getShowtimesByMovie(m.id, ids);
        const cutoff = now().getTime();
        const per = new Map<string, Set<string>>();
        for (const s of st) if (Date.parse(s.startsAt) >= cutoff) per.set(s.cinemaId, (per.get(s.cinemaId) ?? new Set()).add(s.date));
        return ok({
          movie: movieSummary(m, m.id),
          cinemas: [...per].map(([id, dates]) => ({ cinema: cinemaLabel(ctx, id), dates: [...dates].sort() })),
          note: per.size ? undefined : m.presale || m.comingSoon ? `Aún sin funciones en tus cines; estreno ${m.releaseDate ?? "por anunciar"}.` : "Sin funciones en tus cines.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cines_showtimes",
    {
      title: "Showtimes for a movie",
      description:
        "All upcoming showtimes for a movie at the user's cinemas (or the given ones), optionally for one date, language or format. Use cines_best_showtime to recommend one.",
      inputSchema: {
        movie: z.string(),
        cinema: z.string().optional().describe("Name(s) or id(s), comma separated; default all of the user's cinemas"),
        date: z.string().optional(),
        language: z.enum(["SUB", "ESP", "ORIGINAL"]).optional(),
        format: z.string().optional().describe("2D, 3D, 4DX, IMAX, XE, SCREENX, VIP or REGULAR"),
      },
      annotations: READ_ONLY,
    },
    async ({ movie, cinema, date, language, format }) => {
      try {
        const ids = resolveCinemas(cinema, ctx.profile);
        const m = await resolveMovie(ctx, movie, ids);
        const day = date ? resolveDate(date, tz, now()) : undefined;
        const f = format?.toUpperCase();
        const cinemas = await ctx.provider.getCinemas(ids);
        const vip = new Set(cinemas.filter((c) => c.isVip).map((c) => c.id));
        const cutoff = now().getTime();
        const st = (await ctx.provider.getShowtimesByMovie(m.id, ids)).filter(
          (s) =>
            Date.parse(s.startsAt) >= cutoff &&
            (!day || s.date === day) &&
            (!language || s.language === language) &&
            (!f ||
              (f === "VIP" ? vip.has(s.cinemaId) : f === "REGULAR" ? !s.experience && !vip.has(s.cinemaId) : s.experience === f || s.format === f)),
        );
        return ok({ movie: movieSummary(m, m.id), count: st.length, showtimes: st.slice(0, 60).map((s) => compactShowtime(ctx, s)) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cines_best_showtime",
    {
      title: "Recommend the best showtime",
      description:
        "Recommend the best showtime for a movie plus 2 alternatives, using the user's rules: closest cinema, subtitled over dubbed (dubbed only if no subtitled option), inside the time window, regular/VIP before premium formats. Includes warnings (4DX, VIP price, B15/C, special screenings) and ticket prices (default 'Admision General'; cheaper promos are only mentioned).",
      inputSchema: {
        movie: z.string(),
        date: z.string().optional().describe("YYYY-MM-DD, hoy, mañana or weekday; default today"),
        window: z.enum(["morning", "afternoon", "evening", "night", "any"]).optional().describe("'night' = 19:00-24:00 ('en la noche')"),
        after: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("Earliest start HH:MM (overrides window)"),
        before: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("Latest start HH:MM (overrides window)"),
        tickets: z.number().int().min(1).max(10).optional().describe("Number of adult tickets; default 1"),
        vip: z.enum(["only", "exclude", "any"]).optional(),
        format: z.string().optional().describe("Require a format: IMAX, 4DX, XE, SCREENX, 3D or REGULAR"),
        cinema: z.string().optional().describe("Restrict to these cinemas (names or ids)"),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const ids = resolveCinemas(args.cinema, ctx.profile);
        const m = await resolveMovie(ctx, args.movie, ids);
        const day = resolveDate(args.date, tz, now());
        const [cinemas, showtimes] = await Promise.all([ctx.provider.getCinemas(ids), ctx.provider.getShowtimesByMovie(m.id, ids)]);
        const window = (args.window ?? (args.after || args.before ? undefined : "any")) as TimeWindow | undefined;
        const fmt = args.format?.toUpperCase();
        const rank = (d: string) =>
          rankShowtimes(
            showtimes.filter((s) => s.date === d),
            cinemas,
            ctx.profile,
            new Map([[m.id, m]]),
            {
              window,
              after: args.after,
              before: args.before,
              notBefore: new Date(now().getTime() + 20 * 60_000),
              vip: args.vip,
              experiences: fmt ? [fmt === "REGULAR" ? "REGULAR" : fmt] : undefined,
            },
          );
        let scored = rank(day);
        let movedTo: string | undefined;
        if (!scored.length) {
          for (let i = 1; i <= 3 && !scored.length; i++) {
            const d = addDays(day, i);
            scored = rank(d);
            if (scored.length) movedTo = d;
          }
        }
        const { best, alternatives } = pickBestAndAlternatives(scored, 2);
        if (!best) {
          return ok({ movie: movieSummary(m, m.id), date: day, best: null, note: "No hay funciones que cumplan esos criterios en los próximos días." });
        }
        const qty = args.tickets ?? ctx.profile.preferences.defaultTickets;
        const present = async (s: Scored) => ({
          ...compactShowtime(ctx, s.showtime),
          distanceKm: s.distanceKm,
          why: s.reasons.join(", "),
          warnings: s.warnings.length ? s.warnings : undefined,
          price: await ticketAdvice(ctx, s.showtime, qty),
        });
        return ok({
          movie: movieSummary(m, m.id),
          requestedDate: day,
          movedToDate: movedTo,
          tickets: qty,
          best: await present(best),
          alternatives: await Promise.all(alternatives.map(present)),
          clubNote: "Si tienes boletos Club Cinépolis o puntos, Alfred solo los sugiere; nunca se usan automáticamente.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cines_upcoming",
    {
      title: "Upcoming releases and presales",
      description: "Movies coming soon to the user's cinemas, with release dates, rating and whether presale (preventa) is open.",
      inputSchema: {
        days: z.number().int().min(1).max(120).optional().describe("Only releases within this many days; default 45"),
        presaleOnly: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ days, presaleOnly }) => {
      try {
        const ids = resolveCinemas(undefined, ctx.profile);
        const today = localDate(now(), tz);
        const limit = addDays(today, days ?? 45);
        const all = await catalog(ctx, ids);
        const list = all
          .filter((m) => (m.presale || m.comingSoon) && (!m.releaseDate || (m.releaseDate >= today && m.releaseDate <= limit)))
          .filter((m) => !presaleOnly || m.presale)
          .sort((a, b) => (a.releaseDate ?? "9999").localeCompare(b.releaseDate ?? "9999"));
        return ok({
          today,
          movies: list.map((m) => ({ ...movieSummary(m, m.id), presale: m.presale, onSale: m.availableForSale })),
          note: list.length ? undefined : "No hay estrenos anunciados en ese periodo.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}

export type { Cinema };
