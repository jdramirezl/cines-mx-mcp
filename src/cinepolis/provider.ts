/** Cinépolis México provider (read path). */
import { TtlCache } from "../cache.js";
import type { Cinema, Movie, Showtime } from "../domain.js";
import { CinesError } from "../errors.js";
import type { CinemaProvider, MovieCategory, SeatQuery, ShowtimeRef, TicketType } from "../provider.js";
import type { SeatLayout } from "../seats.js";
import { GraphQLClient } from "./client.js";
import { DEFAULT_TZ, mapBillboard, mapCinema, mapMovie } from "./mappers.js";
import { BILLBOARD_BY_CINEMA, BILLBOARD_BY_MOVIE, CINEMAS, MOVIE_DETAIL, MOVIES_LIST, SEATS, TICKETS } from "./queries.js";
import { BillboardSchema, CinemasSchema, MovieSchema, MoviesSchema, parse, SeatsSchema, TicketsSchema } from "./schemas.js";
import { mapSeatLayout } from "./seats.js";
import { z } from "zod";

export interface CinepolisProviderOptions {
  client?: GraphQLClient;
  /** Listing cache TTL (default 10 min). */
  ttlMs?: number;
  /** Seat map cache TTL (default 45 s). */
  seatTtlMs?: number;
  now?: () => number;
}

const MAX_MOVIE_PAGES = 5;

export class CinepolisProvider implements CinemaProvider {
  readonly chain = "cinepolis" as const;
  private readonly client: GraphQLClient;
  private readonly cache: TtlCache<unknown>;
  private readonly tz = new Map<string, string>();

  constructor(opts: CinepolisProviderOptions = {}) {
    this.client = opts.client ?? new GraphQLClient();
    this.cache = new TtlCache(opts.ttlMs ?? 10 * 60_000, opts.now);
    this.seatCache = new TtlCache(opts.seatTtlMs ?? 45_000, opts.now);
  }

  private readonly seatCache: TtlCache<SeatLayout>;

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    return this.cache.get(key, load) as Promise<T>;
  }

  private tzFor = (cinemaId: string) => this.tz.get(cinemaId) ?? DEFAULT_TZ;

  async getCinemas(ids: string[]): Promise<Cinema[]> {
    const sorted = [...new Set(ids)].sort();
    return this.cached(`cinemas|${sorted.join(",")}`, async () => {
      const data = await this.client.call(CINEMAS, { country_id: this.client.countryId, cinemas: sorted.join(",") });
      const cinemas = parse(CinemasSchema, data, "Cinemas").cinemasById.edges.map((e) => mapCinema(e.node));
      for (const c of cinemas) this.tz.set(c.id, c.timezone);
      return cinemas;
    });
  }

  async getShowtimesByCinema(cinemaId: string): Promise<Showtime[]> {
    return this.cached(`bbc|${cinemaId}`, async () => {
      const data = await this.client.call(BILLBOARD_BY_CINEMA, {
        cinemaId,
        countryId: this.client.countryId,
        isAbsoluteExperiencePath: true,
        timezone: this.tzFor(cinemaId),
      });
      const bb = parse(z.object({ billboardByCinema: BillboardSchema }), data, "Billboard").billboardByCinema;
      return mapBillboard(bb, this.tzFor);
    });
  }

  async getShowtimesByMovie(movieId: string, cinemaIds: string[]): Promise<Showtime[]> {
    const ids = [...new Set(cinemaIds)].sort();
    return this.cached(`bbm|${movieId}|${ids.join(",")}`, async () => {
      const data = await this.client.call(BILLBOARD_BY_MOVIE, {
        countryId: this.client.countryId,
        movieId,
        cinemas: ids.join(","),
        timezone: DEFAULT_TZ,
        isAbsoluteExperiencePath: true,
      });
      const bb = parse(z.object({ billboard: BillboardSchema }), data, "Billboard").billboard;
      return mapBillboard(bb, this.tzFor);
    });
  }

  /**
   * Movie catalog for the given cinemas, filtered by category.
   *
   * The `movies` list resolver on api-g is unreliable (2026-10: INTERNAL_ERROR
   * for VIP cinemas, several cinemas at once, or any category but now-playing),
   * while billboards and movie detail always work. So: list per cinema with the
   * exact parameters the site uses, then fill gaps from billboard movie ids via
   * movie detail, and filter categories locally (each node carries them).
   */
  async getMovies(category: MovieCategory, cinemaIds: string[]): Promise<Movie[]> {
    const all = await this.getCatalog(cinemaIds);
    const want = (m: Movie) =>
      category === "now-playing" ? m.nowPlaying : category === "pre-sale" ? m.presale : m.comingSoon || m.presale;
    return all.filter(want);
  }

  async getCatalog(cinemaIds: string[]): Promise<Movie[]> {
    const ids = [...new Set(cinemaIds)].sort();
    return this.cached(`catalog|${ids.join(",")}`, async () => {
      const out = new Map<string, Movie>();
      let listed = 0;
      for (const id of ids) {
        try {
          for (const m of await this.listMovies(id)) out.set(m.id, m);
          listed++;
        } catch (e) {
          if (!(e instanceof CinesError) || e.code === "CINES_BLOCKED" || e.code === "CINES_SCHEMA_CHANGED") throw e;
        }
      }
      const billboardIds = new Set<string>();
      for (const id of ids) for (const s of await this.getShowtimesByCinema(id)) billboardIds.add(s.movieId);
      for (const movieId of billboardIds) {
        if (out.has(movieId)) continue;
        const m = await this.getMovie(movieId).catch((e: unknown) => {
          if (e instanceof CinesError && (e.code === "CINES_NOT_FOUND" || e.code === "CINES_UNAVAILABLE")) return undefined;
          throw e;
        });
        if (m) out.set(m.id, m);
      }
      if (out.size === 0 && listed === 0 && ids.length) {
        throw new CinesError("CINES_UNAVAILABLE", "Cinépolis movie catalog is unavailable right now", { retryable: true });
      }
      return [...out.values()].sort((a, b) => a.title.localeCompare(b.title, "es"));
    });
  }

  private async listMovies(cinemaId: string): Promise<Movie[]> {
    return this.cached(`movies|${cinemaId}`, async () => {
      const out: Movie[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_MOVIE_PAGES; page++) {
        // Variable order and values mirror the site exactly; the backend is picky.
        const vars: Record<string, unknown> = { category: "now-playing", cinemas: cinemaId, limit: 100, countryId: this.client.countryId, isAbsoluteMediaPath: true };
        if (after) vars.after = after;
        const data = await this.client.call(MOVIES_LIST, vars);
        const m = parse(MoviesSchema, data, "Movies").movies;
        out.push(...m.edges.map((e) => mapMovie(e.node)));
        if (!m.pageInfo?.hasNextPage || !m.pageInfo.endCursor) break;
        after = m.pageInfo.endCursor;
      }
      return out;
    });
  }

  async getMovie(id: string): Promise<Movie | undefined> {
    return this.cached(`movie|${id}`, async () => {
      const data = await this.client.call(MOVIE_DETAIL, { countryId: this.client.countryId, id, isAbsoluteMediaPath: true });
      const m = parse(MovieSchema, data, "Movie").movie;
      return m ? mapMovie(m) : undefined;
    });
  }

  async getSeatLayout(q: SeatQuery): Promise<SeatLayout> {
    return this.seatCache.get(`seats|${q.cinemaVistaId}|${q.sessionId}|${q.experience ?? ""}`, async () => {
      const data = await this.client.call(SEATS, {
        cinemaVistaId: q.cinemaVistaId,
        sessionId: q.sessionId,
        countryId: this.client.countryId,
        experience: q.experience ?? "TRADICIONAL",
      });
      return mapSeatLayout(parse(SeatsSchema, data, "Seats"), q.requireContiguous ?? false);
    }, { staleOnError: false });
  }

  async getTickets(ref: ShowtimeRef): Promise<TicketType[]> {
    return this.cached(`tickets|${ref.cinemaVistaId}|${ref.sessionId}`, async () => {
      const data = await this.client.call(TICKETS, {
        cinemaVistaId: ref.cinemaVistaId,
        sessionId: ref.sessionId,
        countryId: this.client.countryId,
      });
      return parse(TicketsSchema, data, "Tickets").tickets.flatMap((area) =>
        area.tickets.map((t) => ({
          id: t.id,
          code: t.ticketTypeCode,
          description: t.description.trim(),
          priceMxn: t.priceInCents / 100,
          bookingFeeMxn: (t.bookingFee ?? 0) / 100,
          areaCategoryCode: area.areaCategoryCode,
          maxPerOrder: t.quantityAvailablePerOrder ?? undefined,
          isPackage: t.isPackageTicket ?? false,
        })),
      );
    });
  }
}
