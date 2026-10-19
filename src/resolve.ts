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

/** Best movie matches for a title query; exact id first, then token overlap on title/original title. */
export function matchMovies(query: string, movies: Movie[]): Movie[] {
  const q = norm(query);
  const exact = movies.filter((m) => m.id === query || norm(m.title) === q || norm(m.originalTitle) === q);
  if (exact.length) return exact;
  const qt = q.split(" ").filter(Boolean);
  const scored = movies
    .map((m) => {
      const hay = `${norm(m.title)} ${norm(m.originalTitle)} ${m.id.replace(/-/g, " ")}`;
      const hit = qt.filter((t) => hay.split(" ").some((w) => w.startsWith(t))).length;
      return { m, score: hit / qt.length + (hay.includes(q) ? 1 : 0) };
    })
    .filter((x) => x.score >= 0.6)
    .sort((a, b) => b.score - a.score);
  return scored.map((x) => x.m);
}
