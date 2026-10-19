import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/cache.js";
import { ApiKeyProvider } from "../src/cinepolis/apikey.js";
import { GraphQLClient } from "../src/cinepolis/client.js";
import { mapAvailability, mapLanguage } from "../src/cinepolis/mappers.js";
import { CinepolisProvider } from "../src/cinepolis/provider.js";
import type { HttpRequest, Transport } from "../src/http/transport.js";
import { addDays, localDate, localToIso } from "../src/time.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const fx = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/cinepolis/${name}.json`, import.meta.url), "utf8"));

/** Fake Cinépolis API answering from the redacted fixtures by operation name. */
function fakeApi(overrides: Record<string, (vars: any) => unknown> = {}) {
  const calls: { op: string; vars: any }[] = [];
  const t: Transport = async (r: HttpRequest) => {
    const body = JSON.parse(r.body ?? "{}");
    const op = body.operationName as string;
    const vars = body.variables;
    calls.push({ op, vars });
    const o = overrides[op];
    let data: unknown;
    if (o) {
      data = o(vars);
      if (data instanceof Error) {
        const err = { message: data.message, extensions: { classification: "INTERNAL_ERROR" } };
        return { status: 200, headers: {}, text: JSON.stringify({ errors: [err], data: { movies: null } }) };
      }
    } else if (op === "Cinemas") data = fx("cinemas");
    else if (op === "Billboard") data = vars.cinemaId ? fx("billboardByCinema").data : fx("billboardByMovie").data;
    else if (op === "Movies") data = vars.id ? fx("movie").data : fx("movies").data;
    else if (op === "Tickets") data = fx("tickets").data;
    else if (op === "Seats") data = fx("seats").data;
    return { status: 200, headers: {}, text: JSON.stringify({ data }) };
  };
  const client = new GraphQLClient({ transport: t, apiKey: new ApiKeyProvider(t, "K"), minIntervalMs: 0 });
  return { client, calls };
}

describe("time", () => {
  it("interprets local times in Mexico City (UTC-6, no DST)", () => {
    expect(localToIso("2026-10-21T20:50:00", "America/Mexico_City")).toBe("2026-10-21T20:50:00-06:00");
    expect(localToIso("2026-07-01T10:00:00", "America/Mexico_City")).toBe("2026-07-01T10:00:00-06:00");
    expect(localToIso("2026-07-01T10:00", "America/Tijuana")).toBe("2026-07-01T10:00:00-07:00");
  });
  it("computes local dates and adds days", () => {
    expect(localDate(new Date("2026-10-20T03:00:00Z"), "America/Mexico_City")).toBe("2026-10-19");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("mappers", () => {
  it("decodes availability colors from the site constants", () => {
    expect(mapAvailability("")).toBe("free");
    expect(mapAvailability("#FFBE06")).toBe("average");
    expect(mapAvailability("#ff804a")).toBe("half_full");
    expect(mapAvailability("#A2ACBA")).toBe("full");
    expect(mapAvailability("#123456")).toBe("unknown");
  });
  it("maps language codes", () => {
    expect(mapLanguage("SUB")).toBe("SUB");
    expect(mapLanguage("esp")).toBe("ESP");
    expect(mapLanguage("DOB")).toBe("OTHER");
  });
});

describe("CinepolisProvider", () => {
  it("lists the user's cinemas with VIP flag, vistaId and seating rules", async () => {
    const p = new CinepolisProvider({ client: fakeApi().client });
    const cinemas = await p.getCinemas(["cinepolis-parque-toreo-cdmx", "cinepolis-vip-miyana-polanco-cdmx"]);
    const toreo = cinemas.find((c) => c.id === "cinepolis-parque-toreo-cdmx");
    expect(toreo).toMatchObject({ vistaId: "570", isVip: false, timezone: "America/Mexico_City", requireContiguousSeating: false });
    expect(cinemas.find((c) => c.id === "cinepolis-vip-miyana-polanco-cdmx")?.isVip).toBe(true);
    expect(cinemas).toHaveLength(7);
  });

  it("normalizes a cinema billboard into sorted showtimes", async () => {
    const p = new CinepolisProvider({ client: fakeApi().client });
    const st = await p.getShowtimesByCinema("cinepolis-parque-toreo-cdmx");
    expect(st.length).toBeGreaterThan(50);
    const sorted = [...st].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    expect(st.map((s) => s.id)).toEqual(sorted.map((s) => s.id));
    const s = st[0]!;
    expect(s.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00-06:00$/);
    expect(s.date).toBe(s.startsAt.slice(0, 10));
    expect(s.id).toBe(`${s.cinemaVistaId}-${s.sessionId}`);
    expect(new Set(st.map((x) => x.language))).toEqual(new Set(["SUB", "ESP"]));
    expect(st.some((x) => x.experience === "4DX")).toBe(true);
    expect(st.some((x) => x.format === "3D")).toBe(true);
    expect(st.every((x) => x.experience !== "TRADICIONAL")).toBe(true);
  });

  it("returns a movie's showtimes across cinemas", async () => {
    const p = new CinepolisProvider({ client: fakeApi().client });
    const st = await p.getShowtimesByMovie("street-fighter", ["cinepolis-parque-toreo-cdmx", "cinepolis-satelite-cdmx"]);
    expect(new Set(st.map((s) => s.movieId))).toEqual(new Set(["street-fighter"]));
    expect(new Set(st.map((s) => s.cinemaId)).size).toBeGreaterThan(1);
  });

  it("maps movies with rating, release date and presale flags", async () => {
    const p = new CinepolisProvider({ client: fakeApi().client });
    const movies = await p.getMovies("now-playing", ["cinepolis-parque-toreo-cdmx"]);
    const sf = movies.find((m) => m.id === "street-fighter")!;
    expect(sf).toMatchObject({ title: "Street Fighter", rating: "B", durationMin: 119, releaseDate: "2026-10-15", nowPlaying: true, presale: false });
    const pre = await p.getMovies("pre-sale", ["cinepolis-parque-toreo-cdmx"]);
    expect(pre.length).toBeGreaterThan(0);
    expect(pre.every((m) => m.presale && m.releaseDate! >= "2026-10-19")).toBe(true);
    const detail = await p.getMovie("street-fighter");
    expect(detail?.title).toBe("Street Fighter");
  });

  it("sends the Movies list with the site's exact variables, one cinema per call", async () => {
    const api = fakeApi();
    const p = new CinepolisProvider({ client: api.client });
    await p.getMovies("pre-sale", ["cinepolis-satelite-cdmx", "cinepolis-parque-toreo-cdmx"]);
    const list = api.calls.filter((c) => c.op === "Movies" && !c.vars.id);
    expect(list.map((c) => c.vars.cinemas).sort()).toEqual(["cinepolis-parque-toreo-cdmx", "cinepolis-satelite-cdmx"]);
    expect(Object.keys(list[0]!.vars)).toEqual(["category", "cinemas", "limit", "countryId", "isAbsoluteMediaPath"]);
    expect(list.every((c) => c.vars.category === "now-playing" && c.vars.limit === 100)).toBe(true);
  });

  it("falls back to billboard ids + movie detail when the list resolver fails", async () => {
    const api = fakeApi({ Movies: (v) => (v.id ? fx("movie").data : new Error("An unexpected error occurred. Please try again later.")) });
    const p = new CinepolisProvider({ client: api.client });
    const movies = await p.getMovies("now-playing", ["cinepolis-vip-parque-toreo-cdmx"]);
    expect(movies.length).toBeGreaterThan(0);
    expect(api.calls.some((c) => c.op === "Movies" && c.vars.id)).toBe(true);
  });

  it("lists ticket types in pesos", async () => {
    const p = new CinepolisProvider({ client: fakeApi().client });
    const t = await p.getTickets({ cinemaVistaId: "570", sessionId: "1" });
    expect(t.find((x) => /Admision General/i.test(x.description))?.priceMxn).toBe(92);
    expect(t.every((x) => x.priceMxn > 0)).toBe(true);
  });

  it("caches each query for the TTL and refetches after it", async () => {
    let now = 0;
    const api = fakeApi();
    const p = new CinepolisProvider({ client: api.client, now: () => now, ttlMs: 600_000 });
    await p.getShowtimesByCinema("cinepolis-parque-toreo-cdmx");
    await p.getShowtimesByCinema("cinepolis-parque-toreo-cdmx");
    expect(api.calls.filter((c) => c.op === "Billboard")).toHaveLength(1);
    now += 600_001;
    await p.getShowtimesByCinema("cinepolis-parque-toreo-cdmx");
    expect(api.calls.filter((c) => c.op === "Billboard")).toHaveLength(2);
  });

  it("raises CINES_SCHEMA_CHANGED when the payload shape changes", async () => {
    const api = fakeApi({ Billboard: () => ({ billboardByCinema: { dates: [], schedules: [{ cinemaId: "x" }] } }) });
    const p = new CinepolisProvider({ client: api.client });
    await expect(p.getShowtimesByCinema("x")).rejects.toMatchObject({ code: "CINES_SCHEMA_CHANGED" });
  });
});

describe("TtlCache", () => {
  it("serves stale data when a refresh fails", async () => {
    let now = 0;
    const c = new TtlCache<number>(10, () => now);
    expect(await c.get("k", async () => 1)).toBe(1);
    now = 100;
    expect(await c.get("k", async () => Promise.reject(new Error("down")))).toBe(1);
  });
});
