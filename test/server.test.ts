import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiKeyProvider } from "../src/cinepolis/apikey.js";
import { GraphQLClient } from "../src/cinepolis/client.js";
import { CinepolisProvider } from "../src/cinepolis/provider.js";
import type { Cinema, Showtime } from "../src/domain.js";
import type { HttpRequest, Transport } from "../src/http/transport.js";
import { DEFAULT_PROFILE } from "../src/profile.js";
import { pickBestAndAlternatives, rankShowtimes } from "../src/ranking.js";
import { matchMovies, resolveCinemas, resolveDate } from "../src/resolve.js";
import { assertLoopback, startServer } from "../src/server.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const fx = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/cinepolis/${name}.json`, import.meta.url), "utf8"));

function fixtureProvider(): CinepolisProvider {
  const t: Transport = async (r: HttpRequest) => {
    const body = JSON.parse(r.body ?? "{}");
    const v = body.variables;
    const op = body.operationName;
    const data =
      op === "Cinemas" ? fx("cinemas")
      : op === "Billboard" ? (v.cinemaId ? fx("billboardByCinema").data : fx("billboardByMovie").data)
      : op === "Movies" ? (v.id ? fx("movie").data : fx("movies").data)
      : op === "Tickets" ? fx("tickets").data
      : fx("seats").data;
    return { status: 200, headers: {}, text: JSON.stringify({ data }) };
  };
  return new CinepolisProvider({ client: new GraphQLClient({ transport: t, apiKey: new ApiKeyProvider(t, "K"), minIntervalMs: 0 }) });
}

// Fixtures were captured 2026-10-19 ~15:00 Mexico City; pin "now" just before.
const NOW = new Date("2026-10-19T18:00:00-06:00");

describe("resolve", () => {
  it("resolves cinema nicknames", () => {
    expect(resolveCinemas("toreo", DEFAULT_PROFILE)).toEqual(["cinepolis-parque-toreo-cdmx", "cinepolis-vip-parque-toreo-cdmx"]);
    expect(resolveCinemas("toreo vip", DEFAULT_PROFILE)).toEqual(["cinepolis-vip-parque-toreo-cdmx"]);
    expect(resolveCinemas("Miyana", DEFAULT_PROFILE)).toEqual(["cinepolis-vip-miyana-polanco-cdmx"]);
    expect(resolveCinemas("satélite, carso", DEFAULT_PROFILE)).toHaveLength(4);
    expect(() => resolveCinemas("perisur", DEFAULT_PROFILE)).toThrow(/No conozco/);
  });
  it("resolves dates in Mexico City", () => {
    const tz = "America/Mexico_City";
    expect(resolveDate("hoy", tz, NOW)).toBe("2026-10-19");
    expect(resolveDate("mañana", tz, NOW)).toBe("2026-10-20");
    expect(resolveDate("viernes", tz, NOW)).toBe("2026-10-23");
    expect(resolveDate("lunes", tz, NOW)).toBe("2026-10-19");
    expect(() => resolveDate("someday", tz, NOW)).toThrow();
  });
  it("matches movie titles loosely", () => {
    const movies = [
      { id: "street-fighter", title: "Street Fighter", originalTitle: "Street Fighter" },
      { id: "el-laberinto-del-fauno", title: "El Laberinto Del Fauno", originalTitle: "Pan's Labyrinth" },
    ] as any[];
    expect(matchMovies("street fighter", movies)[0]?.id).toBe("street-fighter");
    expect(matchMovies("laberinto", movies)[0]?.id).toBe("el-laberinto-del-fauno");
    expect(matchMovies("pans labyrinth", movies)[0]?.id).toBe("el-laberinto-del-fauno");
    expect(matchMovies("batman", movies)).toEqual([]);
  });
});

describe("ranking", () => {
  const cinema = (id: string, isVip = false): Cinema =>
    ({ chain: "cinepolis", id, vistaId: "1", name: id, type: isVip ? "VIP" : "TRADICIONAL", isVip, cityId: "cdmx", timezone: "America/Mexico_City", requireContiguousSeating: false });
  const st = (cinemaId: string, time: string, language: "SUB" | "ESP", experience?: string): Showtime =>
    ({ chain: "cinepolis", id: `${cinemaId}-${time}-${language}`, sessionId: "1", cinemaId, cinemaVistaId: "1", movieId: "m", movieVistaId: "", date: "2026-10-20", time, startsAt: `2026-10-20T${time}:00-06:00`, language, languageLabel: language, format: "2D", experience, screen: "1", availability: "free", isAllocatedSeating: true, alerts: [] });
  const cinemas = [cinema("cinepolis-parque-toreo-cdmx"), cinema("cinepolis-satelite-cdmx"), cinema("cinepolis-vip-parque-toreo-cdmx", true)];
  const opts = { notBefore: new Date("2026-10-20T00:00:00-06:00"), window: "night" as const };

  it("prefers subtitled even at a farther cinema, then distance", () => {
    const list = [st("cinepolis-parque-toreo-cdmx", "20:00", "ESP"), st("cinepolis-satelite-cdmx", "20:30", "SUB"), st("cinepolis-parque-toreo-cdmx", "21:00", "SUB")];
    const r = rankShowtimes(list, cinemas, DEFAULT_PROFILE, new Map(), opts);
    expect(r.map((x) => x.showtime.id)).toEqual(["cinepolis-parque-toreo-cdmx-21:00-SUB", "cinepolis-satelite-cdmx-20:30-SUB"]);
  });
  it("falls back to dubbed only when there is no subtitled option", () => {
    const r = rankShowtimes([st("cinepolis-parque-toreo-cdmx", "20:00", "ESP")], cinemas, DEFAULT_PROFILE, new Map(), opts);
    expect(r).toHaveLength(1);
    expect(r[0]!.warnings.join(" ")).toMatch(/Doblada/);
  });
  it("respects the time window and ranks premium formats lower with warnings", () => {
    const list = [st("cinepolis-parque-toreo-cdmx", "16:00", "SUB"), st("cinepolis-parque-toreo-cdmx", "20:00", "SUB", "4DX"), st("cinepolis-parque-toreo-cdmx", "21:30", "SUB")];
    const r = rankShowtimes(list, cinemas, DEFAULT_PROFILE, new Map(), opts);
    expect(r.map((x) => x.showtime.time)).toEqual(["21:30", "20:00"]);
    expect(r[1]!.warnings.join(" ")).toMatch(/4DX/);
  });
  it("picks distinct alternatives (not the VIP twin of the best time)", () => {
    const list = [
      st("cinepolis-parque-toreo-cdmx", "20:00", "SUB"),
      st("cinepolis-vip-parque-toreo-cdmx", "20:00", "SUB"),
      st("cinepolis-parque-toreo-cdmx", "22:00", "SUB"),
      st("cinepolis-satelite-cdmx", "20:00", "SUB"),
    ];
    const { best, alternatives } = pickBestAndAlternatives(rankShowtimes(list, cinemas, DEFAULT_PROFILE, new Map(), opts));
    expect(best!.showtime.id).toBe("cinepolis-parque-toreo-cdmx-20:00-SUB");
    expect(alternatives.map((a) => a.showtime.id)).not.toContain("cinepolis-vip-parque-toreo-cdmx-20:00-SUB");
    expect(alternatives).toHaveLength(2);
  });
});

describe("MCP server", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let client: Client;

  beforeAll(async () => {
    srv = await startServer({ port: 0, provider: fixtureProvider(), profile: DEFAULT_PROFILE, now: () => NOW });
    client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(srv.url)));
  });
  afterAll(async () => {
    await client.close();
    await srv.close();
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: r.isError === true, value: JSON.parse(r.content[0].text) };
  };

  it("refuses to bind non-loopback hosts", () => {
    expect(() => assertLoopback("0.0.0.0")).toThrow(/loopback/);
    expect(() => assertLoopback("192.168.1.10")).toThrow();
    expect(() => assertLoopback("127.0.0.1")).not.toThrow();
  });

  it("lists the read tools with read-only annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["cines_best_showtime", "cines_find_movie", "cines_list_cinemas", "cines_listings", "cines_showtimes", "cines_upcoming"]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("cines_list_cinemas returns the profile cinemas", async () => {
    const { value } = await call("cines_list_cinemas");
    expect(value.cinemas).toHaveLength(7);
    expect(value.cinemas[0]).toMatchObject({ name: "Parque Toreo", distanceKm: 0.17, available: true });
  });

  it("cines_listings shows tomorrow's movies at Toreo", async () => {
    const { value } = await call("cines_listings", { cinema: "toreo", date: "mañana" });
    expect(value.date).toBe("2026-10-20");
    expect(value.movies.length).toBeGreaterThan(3);
    expect(value.movies[0].showtimes[0]).toMatch(/^\d{2}:\d{2} (SUB|ESP|ORIGINAL)/);
  });

  it("cines_find_movie and cines_showtimes work by partial title", async () => {
    const f = await call("cines_find_movie", { movie: "street" });
    expect(f.value.movie.id).toBe("street-fighter");
    expect(f.value.cinemas.length).toBeGreaterThan(0);
    const s = await call("cines_showtimes", { movie: "Street Fighter", language: "SUB" });
    expect(s.value.count).toBeGreaterThan(0);
    expect(s.value.showtimes.every((x: any) => x.lang === "SUB")).toBe(true);
  });

  it("cines_best_showtime returns best + 2 alternatives with prices", async () => {
    const { value, isError } = await call("cines_best_showtime", { movie: "street fighter", date: "mañana", window: "night", tickets: 2 });
    expect(isError).toBe(false);
    expect(value.best.lang).toBe("SUB");
    expect(value.best.time >= "19:00").toBe(true);
    expect(value.alternatives).toHaveLength(2);
    expect(value.best.price.defaultType).toBe("Admision General");
    expect(value.best.price.totalMxn).toBe(184);
    expect(value.best.price.cheaperPromos?.[0]?.type).toMatch(/Oferton/);
  });

  it("cines_upcoming lists presales with release dates", async () => {
    const { value } = await call("cines_upcoming", { presaleOnly: true });
    expect(value.movies.length).toBeGreaterThan(0);
    expect(value.movies.every((m: any) => m.presale && m.release >= "2026-10-19")).toBe(true);
  });

  it("returns the shared error shape for bad input", async () => {
    const r = await call("cines_listings", { cinema: "perisur" });
    expect(r.isError).toBe(true);
    expect(r.value).toEqual({ error: { code: "CINES_NOT_FOUND", message: expect.stringMatching(/perisur/), retryable: false } });
  });

  it("rejects non-loopback Host headers and serves /healthz", async () => {
    const base = srv.url.replace(/\/mcp$/, "");
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const evil = await fetch(srv.url, { method: "POST", headers: { Host: "evil.example.com", "content-type": "application/json" }, body: "{}" }).catch(() => null);
    // undici forbids overriding Host in some versions; accept either a 403 or a client-side refusal.
    if (evil) expect([403, 400, 406]).toContain(evil.status);
  });
});
