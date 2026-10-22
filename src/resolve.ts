/** Resolve the user's loose input (cinema names, movie titles, dates) to ids. */
import type { Movie } from "./domain.js";
import { CinesError } from "./errors.js";
import type { Profile } from "./profile.js";
import { addDays, localDate } from "./time.js";

export function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const STOP = new Set(["cinepolis", "cdmx", "cine", "el", "la", "los", "las", "de", "del", "plaza", "the"]);
const tokens = (s: string) => norm(s).split(" ").filter((t) => t && !STOP.has(t));

/** "toreo" -> both Toreo cinemas; "toreo vip" -> VIP only; exact id passes through. */
export function resolveCinemas(input: string | string[] | undefined, profile: Profile): string[] {
  const all = profile.cinemas.map((c) => c.id);
  if (input === undefined || (Array.isArray(input) && input.length === 0)) return all;
  const list = Array.isArray(input) ? input : input.split(/[,;]| y | and /i);
  const out = new Set<string>();
  for (const raw of list) {
    const q = raw.trim();
    if (!q) continue;
    if (/^(todos|all|mis cines|any)$/i.test(q)) return all;
    const exact = profile.cinemas.find((c) => c.id === q);
    if (exact) {
      out.add(exact.id);
      continue;
    }
    const wantVip = /\bvip\b/i.test(q);
    const qt = tokens(q).filter((t) => t !== "vip");
    const hits = profile.cinemas.filter((c) => {
      const ct = new Set([...tokens(c.label), ...tokens(c.id)]);
      return qt.length > 0 && qt.every((t) => [...ct].some((x) => x.startsWith(t))) && (!wantVip || c.vip);
    });
    if (!hits.length) {
      if (/^cinepolis-[a-z0-9-]+$/.test(q)) {
        out.add(q);
        continue;
      }
      throw new CinesError("CINES_NOT_FOUND", `No conozco el cine "${q}". Opciones: ${profile.cinemas.map((c) => c.label).join(", ")}`);
    }
    for (const h of hits) out.add(h.id);
  }
  return [...out];
}

/** YYYY-MM-DD | today/hoy | tomorrow/mañana | pasado mañana | weekday name (next occurrence). */
export function resolveDate(input: string | undefined, tz: string, now = new Date()): string {
  const today = localDate(now, tz);
  if (!input) return today;
  const q = norm(input);
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.trim())) return input.trim();
  if (q === "today" || q === "hoy" || q === "tonight" || q === "esta noche") return today;
  if (q === "tomorrow" || q === "manana") return addDays(today, 1);
  if (q === "pasado manana" || q === "day after tomorrow") return addDays(today, 2);
  const days = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
  const en = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const idx = days.indexOf(q) >= 0 ? days.indexOf(q) : en.indexOf(q);
  if (idx >= 0) {
    const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
    return addDays(today, (idx - dow + 7) % 7);
  }
  throw new CinesError("CINES_BAD_REQUEST", `Fecha no reconocida: "${input}". Usa YYYY-MM-DD, hoy, mañana o un día de la semana.`);
}

/** Words that are packaging, not title: (TBC), Reestreno, Subtitulada, formats… */
const TITLE_NOISE = new Set(["tbc", "reestreno", "re", "estreno", "subtitulada", "subtitulado", "doblada", "doblado", "sub", "esp", "version", "original", "2d", "3d", "4dx", "imax", "xe", "screenx", "vip", "pelicula", "movie", "film", "aniversario", "anniversary", "edicion", "especial"]);
/** Articles/prepositions ignored when scoring (but kept when the whole query is short). */
const TITLE_STOP = new Set(["el", "la", "los", "las", "un", "una", "de", "del", "y", "the", "a", "an", "of", "and"]);

/** Normalized title: accents, case, punctuation and bracketed/packaging noise removed. */
export function normTitle(s: string): string {
  const base = s.replace(/[([{][^)\]}]*[)\]}]/g, " ");
  return norm(base)
    .split(" ")
    .filter((t) => t && !TITLE_NOISE.has(t))
    .join(" ");
}

/**
 * Known alternate titles (normalized) for movies whose Spanish title differs
 * from the English/original one the user may say. Cinépolis gives one
 * `originalName`; this covers the rest. Keep small.
 */
export const TITLE_ALIASES: Record<string, string[]> = {
  "kimi no na wa": ["your name", "tu nombre"],
  "your name": ["kimi no na wa", "tu nombre"],
  "sen to chihiro no kamikakushi": ["spirited away", "el viaje de chihiro"],
  "spirited away": ["el viaje de chihiro"],
  "tonari no totoro": ["my neighbor totoro", "mi vecino totoro"],
  "mononoke hime": ["princess mononoke", "la princesa mononoke"],
  "howls moving castle": ["el increible castillo vagabundo"],
  "pans labyrinth": ["el laberinto del fauno"],
};

function lev1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length === b.length && a[i] === b[j + 1] && a[i + 1] === b[j]) {
      i += 2; // adjacent transposition ("frankenstien")
      j += 2;
      continue;
    }
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function tokenHit(q: string, words: string[]): boolean {
  return words.some((w) => w === q || (q.length >= 3 && w.startsWith(q)) || (q.length >= 5 && w.length >= 5 && lev1(q, w)));
}

/** 0..1: share of the query's meaningful tokens found in the title, plus coverage of the title. */
export function titleScore(query: string, title: string): number {
  const q = normTitle(query);
  const t = normTitle(title);
  if (!q || !t) return 0;
  if (q === t) return 1;
  const qAll = q.split(" ");
  const qt = qAll.filter((x) => !TITLE_STOP.has(x));
  const qs = qt.length ? qt : qAll;
  const words = t.split(" ");
  const meaningful = words.filter((x) => !TITLE_STOP.has(x));
  const hits = qs.filter((x) => tokenHit(x, words)).length;
  const recall = hits / qs.length;
  const covered = meaningful.filter((w) => qs.some((x) => w === x || (x.length >= 3 && w.startsWith(x)))).length / Math.max(1, meaningful.length);
  const phrase = ` ${t} `.includes(` ${q} `) ? 0.1 : 0;
  return Math.min(0.99, recall * 0.75 + covered * 0.25 + phrase);
}

export const MATCH_THRESHOLD = 0.6;

/** Query variants: as given, its parts ("Your Name - Kimi no Na wa"), aliases, hub-provided alternates. */
export function queryVariants(query: string, altTitles: string[] = []): string[] {
  const out = new Set<string>();
  for (const raw of [query, ...altTitles]) {
    if (!raw?.trim()) continue;
    out.add(raw);
    for (const part of raw.split(/\s[-–—:/|]\s|\s*[/|]\s*|\s*[(（][^)）]*[)）]\s*/)) if (normTitle(part)) out.add(part);
    const inner = /[(（]([^)）]+)[)）]/.exec(raw)?.[1];
    if (inner && normTitle(inner)) out.add(inner);
  }
  for (const v of [...out]) for (const a of TITLE_ALIASES[normTitle(v)] ?? []) out.add(a);
  return [...out];
}

export interface MovieMatch {
  movie: Movie;
  score: number;
  /** The title (or alternate) that matched. */
  via: string;
}

/** Ranked matches across title, original title, id slug and alternates. */
export function scoreMovies(query: string, movies: Movie[], altTitles: string[] = []): MovieMatch[] {
  const variants = queryVariants(query, altTitles);
  const out: MovieMatch[] = [];
  for (const m of movies) {
    if (m.id === query.trim()) {
      out.push({ movie: m, score: 1, via: m.id });
      continue;
    }
    let best = { score: 0, via: "" };
    for (const name of [m.title, m.originalTitle, m.id.replace(/-/g, " ")]) {
      if (!name) continue;
      for (const v of variants) {
        const sc = titleScore(v, name);
        if (sc > best.score) best = { score: sc, via: name };
      }
    }
    if (best.score >= MATCH_THRESHOLD) out.push({ movie: m, ...best });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Best movie matches for a title query (see scoreMovies). */
export function matchMovies(query: string, movies: Movie[], altTitles: string[] = []): Movie[] {
  const scored = scoreMovies(query, movies, altTitles);
  const exact = scored.filter((x) => x.score >= 1);
  return (exact.length ? exact : scored).map((x) => x.movie);
}
