/**
 * Chain-independent domain model. Providers (Cinépolis today, Cinemex later)
 * map their own payloads onto these types.
 */

export type ChainId = "cinepolis";

/** SUB = original audio + Spanish subtitles; ESP = Spanish dub; ORIGINAL = original audio, no subs. */
export type Language = "SUB" | "ESP" | "ORIGINAL" | "OTHER";

export type Availability = "free" | "average" | "half_full" | "full" | "unknown";

export interface Cinema {
  chain: ChainId;
  id: string;
  vistaId: string;
  name: string;
  /** Chain-specific room class, e.g. TRADICIONAL or VIP. */
  type: string;
  isVip: boolean;
  cityId: string;
  timezone: string;
  lat?: number;
  lng?: number;
  requireContiguousSeating: boolean;
}

export interface Movie {
  chain: ChainId;
  id: string;
  title: string;
  originalTitle: string;
  /** Mexican classification: AA, A, B, B15, C, D, or TBC. */
  rating: string;
  ratingDescription: string;
  genres: string[];
  durationMin?: number;
  synopsis: string;
  /** Release date (YYYY-MM-DD, Mexico City). */
  releaseDate?: string;
  availableForSale: boolean;
  categories: string[];
  /** True when tickets are on sale before the release date. */
  presale: boolean;
  comingSoon: boolean;
  nowPlaying: boolean;
  experiences: string[];
  tags: string[];
  alerts: { title: string; message: string }[];
  posterUrl?: string;
}

export interface Showtime {
  chain: ChainId;
  /** Stable id: `<cinemaVistaId>-<sessionId>`. */
  id: string;
  sessionId: string;
  cinemaId: string;
  cinemaVistaId: string;
  movieId: string;
  movieVistaId: string;
  /** Local date YYYY-MM-DD in the cinema's timezone. */
  date: string;
  /** Local time HH:MM in the cinema's timezone. */
  time: string;
  /** ISO 8601 with offset. */
  startsAt: string;
  language: Language;
  languageLabel: string;
  /** Projection format: 2D, 3D… */
  format: string;
  /** Premium experience code (4DX, IMAX, XE, SCREENX, SJ…) or undefined for regular. */
  experience?: string;
  screen: string;
  availability: Availability;
  isAllocatedSeating: boolean;
  alerts: { section?: string; title: string; message: string }[];
}

export const EXPERIENCE_LABEL: Record<string, string> = {
  "4DX": "4DX",
  XE: "Macro XE",
  IMAX: "IMAX",
  SCREENX: "ScreenX",
  SJ: "Sala Junior",
  "3D": "3D",
};

export const RATING_MIN_AGE: Record<string, number> = { AA: 0, A: 0, B: 12, B15: 15, C: 18, D: 18 };
