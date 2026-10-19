/**
 * Showtime ranking for "I want to see X tonight": closest cinema, preferred
 * language, inside the time window, regular/VIP before premium formats.
 * Pure functions; the tool layer adds prices and advice.
 */
import { EXPERIENCE_LABEL, RATING_MIN_AGE, type Cinema, type Language, type Movie, type Showtime } from "./domain.js";
import type { Profile } from "./profile.js";

export type TimeWindow = "morning" | "afternoon" | "evening" | "night" | "any";

/** Local HH:MM bounds (inclusive start, exclusive end). Night runs past midnight. */
export const WINDOWS: Record<Exclude<TimeWindow, "any">, [string, string]> = {
  morning: ["09:00", "13:00"],
  afternoon: ["13:00", "18:00"],
  evening: ["18:00", "21:00"],
  night: ["19:00", "24:00"],
};

export interface RankOptions {
  window?: TimeWindow;
  /** Explicit bounds override `window`. */
  after?: string;
  before?: string;
  /** Only consider showtimes starting after this instant (default now + 20 min). */
  notBefore?: Date;
  /** Restrict to these experiences (e.g. ["IMAX"]); "regular" means no premium experience. */
  experiences?: string[];
  vip?: "only" | "exclude" | "any";
  languages?: Language[];
}

export interface Scored {
  showtime: Showtime;
  cinema: Cinema;
  distanceKm: number;
  score: number;
  reasons: string[];
  warnings: string[];
}

export function inWindow(time: string, after: string, before: string): boolean {
  return time >= after && time < (before === "24:00" ? "24:00" : before);
}

export function warningsFor(s: Showtime, cinema: Cinema | undefined, movie: Movie | undefined): string[] {
  const w: string[] = [];
  if (s.experience === "4DX") w.push("4DX: asientos con movimiento, agua y viento; no recomendado si te mareas.");
  if (s.experience && s.experience !== "4DX") w.push(`${EXPERIENCE_LABEL[s.experience] ?? s.experience}: formato premium, precio más alto.`);
  if (s.format === "3D") w.push("3D: requiere lentes; precio más alto.");
  if (cinema?.isVip) w.push("VIP: precio más alto; servicio a la butaca.");
  const minAge = movie ? RATING_MIN_AGE[movie.rating] : undefined;
  if (movie && (movie.rating === "B15" || movie.rating === "C" || movie.rating === "D")) {
    w.push(`Clasificación ${movie.rating} (${minAge}+). ${movie.rating === "C" || movie.rating === "D" ? "Piden identificación." : ""}`.trim());
  }
  if (movie?.rating === "TBC") w.push("Clasificación aún no publicada.");
  if (s.language === "ESP") w.push("Doblada al español (no hay o no elegiste subtitulada).");
  if (s.availability === "half_full") w.push("Sala más de la mitad llena.");
  if (s.availability === "full") w.push("Sala casi o totalmente llena.");
  for (const a of s.alerts) if (a.title || a.message) w.push(`Aviso de Cinépolis: ${[a.title, a.message].filter(Boolean).join(" — ")}`);
  for (const a of movie?.alerts ?? []) if (a.title || a.message) w.push(`Aviso de la película: ${[a.title, a.message].filter(Boolean).join(" — ")}`);
  if (movie && movie.tags.some((t) => /especial|evento|concierto|live/i.test(t)) || movie?.genres.some((g) => /CONCIERTO|EVENTO/i.test(g))) {
    w.push("Función especial/evento: precio y reglas pueden ser distintos.");
  }
  return w;
}

export function rankShowtimes(
  showtimes: Showtime[],
  cinemas: Cinema[],
  profile: Profile,
  movies: Map<string, Movie>,
  opts: RankOptions = {},
): Scored[] {
  const byId = new Map(cinemas.map((c) => [c.id, c]));
  const dist = new Map(profile.cinemas.map((c) => [c.id, c.distanceKm]));
  const langs = opts.languages ?? profile.preferences.languages;
  const notBefore = (opts.notBefore ?? new Date(Date.now() + 20 * 60_000)).getTime();
  const [after, before] =
    opts.after || opts.before
      ? [opts.after ?? "00:00", opts.before ?? "24:00"]
      : opts.window && opts.window !== "any"
        ? WINDOWS[opts.window]
        : ["00:00", "24:00"];
  const wantExp = opts.experiences?.map((e) => e.toUpperCase());

  const candidates = showtimes.filter((s) => {
    const c = byId.get(s.cinemaId);
    if (!c) return false;
    if (Date.parse(s.startsAt) < notBefore) return false;
    if (!inWindow(s.time, after, before)) return false;
    if (s.availability === "full") return false;
    if (opts.vip === "only" && !c.isVip) return false;
    if (opts.vip === "exclude" && c.isVip) return false;
    if (wantExp?.length) {
      const exp = s.experience ?? "REGULAR";
      if (!wantExp.includes(exp) && !(wantExp.includes("3D") && s.format === "3D")) return false;
    }
    return true;
  });

  // Language rule: if any subtitled (or best-ranked language) option exists, drop worse languages entirely.
  const bestLang = langs.find((l) => candidates.some((s) => s.language === l));
  const pool = bestLang ? candidates.filter((s) => s.language === bestLang) : candidates;

  const scored = pool.map((s): Scored => {
    const c = byId.get(s.cinemaId)!;
    const d = dist.get(s.cinemaId) ?? 50;
    const reasons: string[] = [];
    let score = 100;
    score -= d * 6;
    reasons.push(`${d.toFixed(2)} km`);
    const li = langs.indexOf(s.language);
    score -= (li < 0 ? langs.length : li) * 25;
    reasons.push(s.language === "SUB" ? "subtitulada" : s.language === "ESP" ? "doblada" : s.languageLabel.toLowerCase());
    if (profile.preferences.preferRegularOrVip && s.experience && !wantExp?.includes(s.experience)) {
      score -= 8;
      reasons.push(`formato ${EXPERIENCE_LABEL[s.experience] ?? s.experience}`);
    }
    if (s.availability === "half_full") score -= 4;
    if (s.availability === "average") score -= 1;
    // Within the window, earlier is slightly better (less waiting / later return).
    const minutes = Number(s.time.slice(0, 2)) * 60 + Number(s.time.slice(3, 5));
    const startMin = Number(after.slice(0, 2)) * 60 + Number(after.slice(3, 5));
    score -= Math.max(0, minutes - startMin) / 60;
    return { showtime: s, cinema: c, distanceKm: d, score, reasons, warnings: warningsFor(s, c, movies.get(s.movieId)) };
  });
  return scored.sort((a, b) => b.score - a.score || a.showtime.startsAt.localeCompare(b.showtime.startsAt));
}

/** Best + up to `n` alternatives, preferring alternatives that differ in cinema or time. */
export function pickBestAndAlternatives(scored: Scored[], n = 2): { best?: Scored; alternatives: Scored[] } {
  const [best, ...rest] = scored;
  if (!best) return { alternatives: [] };
  const alternatives: Scored[] = [];
  const seen = new Set([`${best.cinema.id}|${best.showtime.time}`]);
  for (const s of rest) {
    if (alternatives.length >= n) break;
    const key = `${s.cinema.id}|${s.showtime.time}`;
    // Skip the VIP twin of the same time when a distinct option exists.
    const twin = s.showtime.time === best.showtime.time && s.distanceKm === best.distanceKm;
    if (seen.has(key) || twin) continue;
    seen.add(key);
    alternatives.push(s);
  }
  for (const s of rest) {
    if (alternatives.length >= n) break;
    if (!alternatives.includes(s)) alternatives.push(s);
  }
  return { best, alternatives };
}
