/** Provider interface: one implementation per cinema chain. */
import type { ChainId, Cinema, Movie, Showtime } from "./domain.js";
import type { SeatLayout } from "./seats.js";

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

export interface SeatQuery extends ShowtimeRef {
  /** Chain experience/area hint: TRADICIONAL, VIP, 4DX, IMAX… */
  experience?: string;
  requireContiguous?: boolean;
}

export interface CinemaProvider {
  readonly chain: ChainId;
  getCinemas(ids: string[]): Promise<Cinema[]>;
  getShowtimesByCinema(cinemaId: string): Promise<Showtime[]>;
  getShowtimesByMovie(movieId: string, cinemaIds: string[]): Promise<Showtime[]>;
  getMovies(category: MovieCategory, cinemaIds: string[]): Promise<Movie[]>;
  getMovie(id: string): Promise<Movie | undefined>;
  getTickets(ref: ShowtimeRef): Promise<TicketType[]>;
  /** Live seat map (short cache: seats change quickly). */
  getSeatLayout(q: SeatQuery): Promise<SeatLayout>;
}
