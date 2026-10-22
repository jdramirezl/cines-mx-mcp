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
import { normTitle, resolveCinemas, resolveDate, scoreMovies, titleScore } from "./resolve.js";
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

/** Default search horizon for "where is X": today + 7 days, or further if Cinépolis published more (max 21). */
export const DEFAULT_SEARCH_DAYS = 7;
const MAX_RANGE_DAYS = 21;

export interface DateRange {
  from: string;
  to: string;
}

/** Resolve dateFrom/date + dateTo/days to an inclusive range (max 21 days). */
export function resolveRange(args: { from?: string; to?: string; days?: number }, tz: string, now: Date, defaultDays = 1): DateRange {
  const from = resolveDate(args.from, tz, now);
  let to = args.to ? resolveDate(args.to, tz, now) : addDays(from, (args.days ?? defaultDays) - 1);
  if (args.to && to < from) {
    // "hasta el domingo" said on a Monday means the coming Sunday, already handled; a past date is a mistake.
    throw new CinesError("CINES_BAD_REQUEST", `El rango termina (${to}) antes de empezar (${from}).`);
  }
  if (to > addDays(from, MAX_RANGE_DAYS - 1)) to = addDays(from, MAX_RANGE_DAYS - 1);
  return { from, to };
}

const RANGE_ARGS = {
  dateTo: z.string().optional().describe("Last date of a range (YYYY-MM-DD, mañana, weekday, e.g. 'domingo' for 'hasta el domingo')"),
  days: z.number().int().min(1).max(21).optional().describe("Range length in days starting at `date` (alternative to dateTo)"),
};
const ALT_TITLES = z
  .array(z.string())
  .max(5)
  .optional()
  .describe("Other titles the user may mean (English/original/Japanese/Spanish), e.g. ['Your Name','Kimi no Na wa']");

/** Movies the user's cinemas show: the catalog plus any billboard movie the catalog missed (title from its id). */
async function searchPool(ctx: ToolContext, cinemaIds: string[]): Promise<{ movies: Movie[]; showtimes: Showtime[] }> {
  const [movies, showtimes] = await Promise.all([catalog(ctx, cinemaIds).catch(() => [] as Movie[]), showtimesFor(ctx, cinemaIds)]);
  const known = new Set(movies.map((m) => m.id));
  const extra: Movie[] = [];
  for (const id of new Set(showtimes.map((x) => x.movieId))) {
    if (known.has(id)) continue;
    const title = id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    extra.push({ chain: "cinepolis", id, title, originalTitle: title, rating: "", ratingDescription: "", genres: [], synopsis: "", availableForSale: true, categories: [], presale: false, comingSoon: false, nowPlaying: true, experiences: [], tags: [], alerts: [] });
  }
  return { movies: [...movies, ...extra], showtimes };
}

function publishedThrough(showtimes: Showtime[]): string | undefined {
  return showtimes.reduce<string | undefined>((m, x) => (!m || x.date > m ? x.date : m), undefined);
}

async function resolveMovie(ctx: ToolContext, query: string, cinemaIds: string[], altTitles: string[] = []): Promise<Movie> {
  const { movies, showtimes } = await searchPool(ctx, cinemaIds);
  const hits = scoreMovies(query, movies, altTitles);
  if (!hits.length) {
    const closest = closestTitles(query, movies, altTitles);
    throw new CinesError(
      "CINES_NOT_FOUND",
      `No encontré "${query}" en la cartelera publicada de ${cinemaIds.map((id) => cinemaLabel(ctx, id)).join(", ")} (publicada hasta ${publishedThrough(showtimes) ?? "—"}).${closest.length ? ` Parecidas: ${closest.join(", ")}.` : ""} Prueba cines_find_movie con altTitles.`,
    );
  }
  const top = hits[0]!;
  if (hits.length >= 4 && top.score < 1 && normTitle(query).length < 4) {
    throw new CinesError("CINES_BAD_REQUEST", `"${query}" es ambiguo: ${hits.slice(0, 5).map((m) => m.movie.title).join(" | ")}`);
  }
  return top.movie;
}

function closestTitles(query: string, movies: Movie[], altTitles: string[]): string[] {
  return movies
    .map((m) => ({ m, s: Math.max(...[query, ...altTitles].flatMap((q) => [titleScore(q, m.title), titleScore(q, m.originalTitle)])) }))
    .filter((x) => x.s >= 0.3)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => x.m.title);
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
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    defaultType: def?.description,
    unitMxn: def?.priceMxn,
    feePerTicketMxn: def?.bookingFeeMxn || undefined,
    totalMxn: def ? round((def.priceMxn + def.bookingFeeMxn) * quantity) : undefined,
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
      title: "Listings for cinemas and a date or date range",
      description:
        "Movies and showtimes at the user's cinemas for a date, or for a date range ('¿qué hay hasta el domingo?' → date:'hoy', dateTo:'domingo'). `cinema` accepts names like 'toreo', 'toreo vip', 'miyana' or 'todos'; default: the home cinema for one day, ALL the user's cinemas for a range. One day returns times; a range returns one line per movie (dates, cinemas, languages) — call again with one cinema and date for times. Languages: SUB=subtitulada, ESP=doblada.",
      inputSchema: {
        cinema: z.string().optional().describe("Cinema name(s) or id(s), or 'todos'; default: home cinema (one day) / all cinemas (range)"),
        date: z.string().optional().describe("YYYY-MM-DD, hoy, mañana, or weekday; default today (start of the range)"),
        ...RANGE_ARGS,
      },
      annotations: READ_ONLY,
    },
    async ({ cinema, date, dateTo, days }) => {
      try {
        const range = resolveRange({ from: date, to: dateTo, days }, tz, now());
        const multi = range.to > range.from;
        const ids = resolveCinemas(cinema ?? (multi ? undefined : ctx.profile.cinemas[0]!.id), ctx.profile);
        const [movies, showtimes] = await Promise.all([catalog(ctx, ids).catch(() => [] as Movie[]), showtimesFor(ctx, ids)]);
        const titles = new Map(movies.map((m) => [m.id, m]));
        const cutoff = now().getTime();
        const inRange = showtimes.filter((s) => s.date >= range.from && s.date <= range.to && Date.parse(s.startsAt) >= cutoff);
        const byMovie = new Map<string, Showtime[]>();
        for (const s of inRange) byMovie.set(s.movieId, [...(byMovie.get(s.movieId) ?? []), s]);
        const published = publishedThrough(showtimes);
        const note = byMovie.size
          ? published && published < range.to
            ? `Cinépolis solo ha publicado funciones hasta ${published}.`
            : undefined
          : showtimes.some((s) => s.date >= range.from)
            ? "No hay funciones restantes en esas fechas."
            : "Cinépolis aún no publica la cartelera de esas fechas.";
        const base = { date: range.from, dateTo: multi ? range.to : undefined, cinemas: ids.map((id) => cinemaLabel(ctx, id)), publishedThrough: published, note };
        if (!multi) {
          return ok({
            ...base,
            movies: [...byMovie].map(([id, list]) => ({
              ...movieSummary(titles.get(id), id),
              showtimes: list.map((s) => `${s.time} ${s.language} ${s.experience ?? s.format}${ids.length > 1 ? ` @${cinemaLabel(ctx, s.cinemaId)}` : ""}${s.availability === "half_full" ? " (llenándose)" : ""}`),
            })),
          });
        }
        return ok({
          ...base,
          movies: [...byMovie]
            .map(([id, list]) => {
              const m = titles.get(id);
              const dates = [...new Set(list.map((s) => s.date))].sort();
              return {
                id,
                title: m?.title ?? id,
                original: m && m.originalTitle !== m.title ? m.originalTitle : undefined,
                rating: m?.rating,
                firstDate: dates[0],
                dates,
                cinemas: [...new Set(list.map((s) => cinemaLabel(ctx, s.cinemaId)))],
                languages: [...new Set(list.map((s) => s.language))],
                formats: [...new Set(list.map((s) => s.experience ?? s.format))],
                showtimes: list.length,
              };
            })
            .sort((a, b) => a.firstDate!.localeCompare(b.firstDate!) || a.title.localeCompare(b.title, "es")),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cines_find_movie",
    {
      title: "Where and when my cinemas show a movie",
      description:
        "Find a movie by title (Spanish, English or original; partial, accents and '(TBC)'-style suffixes ignored) across ALL the user's cinemas over a date range (default today + 7 days, extended to the furthest date Cinépolis has published, max 21). Returns each cinema with its first date and all dates. Pass `altTitles` with other names you know for it. If `found` is false, the result says exactly which range and cinemas were searched: never claim it is not showing outside that range.",
      inputSchema: {
        movie: z.string().describe("Movie title, partial title, or id"),
        altTitles: ALT_TITLES,
        cinema: z.string().optional().describe("Restrict to these cinemas; default all of the user's cinemas"),
        date: z.string().optional().describe("Range start; default today"),
        ...RANGE_ARGS,
      },
      annotations: READ_ONLY,
    },
    async ({ movie, altTitles, cinema, date, dateTo, days }) => {
      try {
        const ids = resolveCinemas(cinema, ctx.profile);
        const { movies, showtimes } = await searchPool(ctx, ids);
        const published = publishedThrough(showtimes);
        let range = resolveRange({ from: date, to: dateTo, days }, tz, now(), DEFAULT_SEARCH_DAYS);
        if (!dateTo && !days && published && published > range.to) range = resolveRange({ from: date, to: published }, tz, now());
        const cutoff = now().getTime();
        const searched = { from: range.from, to: range.to, cinemas: ids.map((id) => cinemaLabel(ctx, id)), publishedThrough: published };
        const hits = scoreMovies(movie, movies, altTitles ?? []);
        const live = (id: string) => showtimes.filter((s) => s.movieId === id && s.date >= range.from && s.date <= range.to && Date.parse(s.startsAt) >= cutoff);
        // Prefer the best-scoring match that actually has showtimes in range.
        const withShows = hits.filter((h) => h.score >= hits[0]!.score - 0.15 && live(h.movie.id).length);
        const pick = withShows[0] ?? hits[0];
        if (!pick) {
          return ok({
            found: false,
            query: movie,
            searched,
            closest: closestTitles(movie, movies, altTitles ?? []),
            note: `No aparece en la cartelera publicada de ${searched.cinemas.join(", ")} entre ${range.from} y ${range.to} (Cinépolis ha publicado hasta ${published ?? "—"}). Puede estrenarse después o con otro título; no digas que no está en cartelera fuera de ese rango.`,
          });
        }
        const m = pick.movie;
        const per = new Map<string, Showtime[]>();
        for (const s of live(m.id)) per.set(s.cinemaId, [...(per.get(s.cinemaId) ?? []), s]);
        const cinemas = [...per]
          .map(([id, list]) => {
            const dates = [...new Set(list.map((s) => s.date))].sort();
            return { cinema: cinemaLabel(ctx, id), firstDate: dates[0]!, dates, languages: [...new Set(list.map((s) => s.language))], formats: [...new Set(list.map((s) => s.experience ?? s.format))] };
          })
          .sort((a, b) => a.firstDate.localeCompare(b.firstDate));
        const others = hits.filter((h) => h.movie.id !== m.id && h.score >= 0.8).slice(0, 3).map((h) => h.movie.title);
        return ok({
          found: cinemas.length > 0,
          movie: movieSummary(m, m.id),
          matchedAs: pick.via !== m.title ? pick.via : undefined,
          firstDate: cinemas[0]?.firstDate,
          cinemas,
          searched,
          alsoMatched: others.length ? others : undefined,
          note: cinemas.length
            ? undefined
            : m.presale || m.comingSoon
              ? `Existe en Cinépolis pero sin funciones en tus cines entre ${range.from} y ${range.to}; estreno ${m.releaseDate ?? "por anunciar"}.`
              : `Existe en Cinépolis pero sin funciones en tus cines entre ${range.from} y ${range.to} (publicado hasta ${published ?? "—"}).`,
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
        "All upcoming showtimes for a movie at the user's cinemas (or the given ones), optionally for one date or a range (date + dateTo/days), language or format. Use cines_best_showtime to recommend one.",
      inputSchema: {
        movie: z.string(),
        altTitles: ALT_TITLES,
        cinema: z.string().optional().describe("Name(s) or id(s), comma separated; default all of the user's cinemas"),
        date: z.string().optional().describe("One date, or the start of a range with dateTo/days; default: all published dates"),
        ...RANGE_ARGS,
        language: z.enum(["SUB", "ESP", "ORIGINAL"]).optional(),
        format: z.string().optional().describe("2D, 3D, 4DX, IMAX, XE, SCREENX, VIP or REGULAR"),
      },
      annotations: READ_ONLY,
    },
    async ({ movie, altTitles, cinema, date, dateTo, days, language, format }) => {
      try {
        const ids = resolveCinemas(cinema, ctx.profile);
        const m = await resolveMovie(ctx, movie, ids, altTitles);
        const range = date || dateTo || days ? resolveRange({ from: date, to: dateTo, days }, tz, now()) : undefined;
        const f = format?.toUpperCase();
        const cinemas = await ctx.provider.getCinemas(ids);
        const vip = new Set(cinemas.filter((c) => c.isVip).map((c) => c.id));
        const cutoff = now().getTime();
        const st = (await ctx.provider.getShowtimesByMovie(m.id, ids)).filter(
          (s) =>
            Date.parse(s.startsAt) >= cutoff &&
            (!range || (s.date >= range.from && s.date <= range.to)) &&
            (!language || s.language === language) &&
            (!f ||
              (f === "VIP" ? vip.has(s.cinemaId) : f === "REGULAR" ? !s.experience && !vip.has(s.cinemaId) : s.experience === f || s.format === f)),
        );
        return ok({ movie: movieSummary(m, m.id), range, count: st.length, truncated: st.length > 60 || undefined, showtimes: st.slice(0, 60).map((s) => compactShowtime(ctx, s)) });
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
        altTitles: ALT_TITLES,
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
        const m = await resolveMovie(ctx, args.movie, ids, args.altTitles);
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
