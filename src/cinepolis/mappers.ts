/** Map Cinépolis payloads onto the shared domain model. */
import type { z } from "zod";
import type { Availability, Cinema, Language, Movie, Showtime } from "../domain.js";
import { localDate, localToIso } from "../time.js";
import type { BillboardSchema, CinemaNodeSchema, MovieNodeSchema } from "./schemas.js";

export const DEFAULT_TZ = "America/Mexico_City";

/** Colors used by the site (schedules micro-frontend constant). */
const AVAILABILITY: Record<string, Availability> = {
  "": "free",
  "#4FC974": "free",
  "#FFBE06": "average",
  "#FF804A": "half_full",
  "#A2ACBA": "full",
};

export function mapAvailability(color: string | null | undefined): Availability {
  return AVAILABILITY[(color ?? "").toUpperCase()] ?? "unknown";
}

export function mapLanguage(code: string): Language {
  const c = code.toUpperCase();
  if (c === "SUB" || c === "ESP" || c === "ORIGINAL") return c;
  return "OTHER";
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && v !== "" && v !== null && v !== undefined ? n : undefined;
};

export function mapCinema(n: z.infer<typeof CinemaNodeSchema>): Cinema {
  const type = (n.type ?? "").toUpperCase();
  return {
    chain: "cinepolis",
    id: n.id,
    vistaId: String(n.vistaId),
    name: n.name,
    type: type || "TRADICIONAL",
    isVip: type === "VIP" || /\bvip\b/i.test(n.id),
    cityId: n.cityId ?? "",
    timezone: n.timezone || DEFAULT_TZ,
    lat: num(n.lat),
    lng: num(n.lng),
    requireContiguousSeating: n.settings?.requireContiguousSeating ?? false,
  };
}

export function mapMovie(n: z.infer<typeof MovieNodeSchema>): Movie {
  const categories = n.categories ?? [];
  const tags = (n.tags ?? []).map((t) => t.name);
  const release = n.releaseDate ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(n.releaseDate) ? n.releaseDate : `${n.releaseDate}Z`) : NaN;
  const minutes = /(\d+)/.exec(n.length ?? "")?.[1];
  const poster = (n.media ?? []).find((m) => /poster/i.test(m.type ?? "") && m.resource)?.resource ?? (n.media ?? [])[0]?.resource ?? undefined;
  return {
    chain: "cinepolis",
    id: n.id,
    title: n.name.trim(),
    originalTitle: (n.originalName ?? n.name).trim(),
    rating: (n.rating ?? "TBC").trim() || "TBC",
    ratingDescription: (n.ratingDescription ?? "").replace(/\s+/g, " ").trim(),
    genres: n.genre ?? [],
    durationMin: minutes ? Number(minutes) : undefined,
    synopsis: (n.synopsis ?? "").trim(),
    releaseDate: Number.isFinite(release) ? localDate(new Date(release), DEFAULT_TZ) : undefined,
    availableForSale: n.availableForSale ?? false,
    categories,
    presale: categories.includes("pre-sale") || tags.some((t) => /preventa/i.test(t)),
    comingSoon: categories.includes("coming-soon"),
    nowPlaying: categories.includes("now-playing"),
    experiences: (n.experiences ?? []).map((e) => e.name),
    tags,
    alerts: (n.alerts ?? []).map((a) => ({ title: a.title ?? "", message: a.message ?? "" })),
    posterUrl: poster ?? undefined,
  };
}

export function mapBillboard(bb: z.infer<typeof BillboardSchema>, tzFor: (cinemaId: string) => string = () => DEFAULT_TZ): Showtime[] {
  const out: Showtime[] = [];
  for (const s of bb.schedules) {
    const tz = tzFor(s.cinemaId);
    for (const d of s.dates) {
      for (const l of d.languages) {
        for (const st of l.showtimes) {
          const startsAt = localToIso(st.datetime, tz);
          const exp = st.experience?.name?.trim();
          out.push({
            chain: "cinepolis",
            id: `${st.cinemaVistaId}-${st.sessionId}`,
            sessionId: st.sessionId,
            cinemaId: s.cinemaId,
            cinemaVistaId: st.cinemaVistaId,
            movieId: s.movieId,
            movieVistaId: st.movieVistaId ?? "",
            date: startsAt.slice(0, 10),
            time: startsAt.slice(11, 16),
            startsAt,
            language: mapLanguage(l.language),
            languageLabel: l.displayLanguage ?? l.language,
            format: st.format?.name ?? "2D",
            experience: exp && !/^(tradicional|2d)$/i.test(exp) ? exp.toUpperCase() : undefined,
            screen: st.screen == null ? "" : String(st.screen),
            availability: mapAvailability(st.availability),
            isAllocatedSeating: st.isAllocatedSeating ?? true,
            alerts: (st.alerts ?? []).map((a) => ({ section: a.section ?? undefined, title: a.title ?? "", message: a.message ?? "" })),
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.cinemaId.localeCompare(b.cinemaId));
}
