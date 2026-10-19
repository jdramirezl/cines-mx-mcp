/** Provider interface: one implementation per cinema chain. */
import type { ChainId, Cinema, Movie, Showtime } from "./domain.js";

export type MovieCategory = "now-playing" | "pre-sale" | "coming-soon";

export interface TicketType {
  id: string;
  code: string;
  description: string;
  priceMxn: number;
  bookingFeeMxn: number;
  areaCategoryCode: string;
  maxPerOrder?: number;
  isPackage: boolean;
}

export interface ShowtimeRef {
  cinemaVistaId: string;
  sessionId: string;
}

export interface CinemaProvider {
  readonly chain: ChainId;
  getCinemas(ids: string[]): Promise<Cinema[]>;
  getShowtimesByCinema(cinemaId: string): Promise<Showtime[]>;
  getShowtimesByMovie(movieId: string, cinemaIds: string[]): Promise<Showtime[]>;
  getMovies(category: MovieCategory, cinemaIds: string[]): Promise<Movie[]>;
  getMovie(id: string): Promise<Movie | undefined>;
  getTickets(ref: ShowtimeRef): Promise<TicketType[]>;
}
