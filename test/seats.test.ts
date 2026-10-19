import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SeatsSchema } from "../src/cinepolis/schemas.js";
import { mapSeatLayout } from "../src/cinepolis/seats.js";
import { renderSeatMapSvg, svgToPng } from "../src/render.js";
import { proposalMode, seatExperience } from "../src/seatTools.js";
import { parseSeatLabels, proposeSeats, segments, strandedSeats, validateSeats, type SeatLayout, type SeatState } from "../src/seats.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = JSON.parse(readFileSync(new URL("./fixtures/cinepolis/seats.json", import.meta.url), "utf8")).data;
const sala6 = () => mapSeatLayout(SeatsSchema.parse(raw));

/** Mark seats taken in a copy of the layout. */
function withTaken(layout: SeatLayout, labels: string[], state: SeatState = "taken"): SeatLayout {
  const set = new Set(labels);
  return { ...layout, rows: layout.rows.map((r) => ({ ...r, seats: r.seats.map((s) => (set.has(s.label) ? { ...s, state } : s)) })) };
}

/** Synthetic room: rows A (front) .. J, `cols` seats each, one aisle after seat `aisleAfter`. */
function room(rows = 10, cols = 14, aisleAfter?: number): SeatLayout {
  const names = "ABCDEFGHIJKLMNOP".slice(0, rows).split("");
  const out = names.map((name, y) => ({
    name,
    y,
    seats: Array.from({ length: cols }, (_, i) => {
      const x = aisleAfter !== undefined && i >= aisleAfter ? i + 1 : i;
      return { label: `${name}${i + 1}`, row: name, number: String(i + 1), x, y, state: "available" as SeatState, areaCode: "1", ref: { areaNumber: 1, rowIndex: rows - 1 - y, columnIndex: x } };
    }),
  }));
  const xs = out.flatMap((r) => r.seats.map((s) => s.x));
  return { areaName: "TRADICIONAL", areaCode: "1", rows: out, minX: Math.min(...xs), maxX: Math.max(...xs), maxQuantity: 10, requireContiguous: false, unknownStatuses: [], counts: { available: rows * cols, taken: 0, wheelchair: 0, companion: 0, blocked: 0 } };
}

describe("Cinépolis seat geometry (Parque Toreo Sala 6 screenshot)", () => {
  const l = sala6();
  it("puts the screen-side row A first and H last", () => {
    expect(l.rows.map((r) => r.name)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]);
  });
  it("mirrors columns so seat 1 is on the left, like the site", () => {
    const h = l.rows.at(-1)!;
    expect(h.seats[0]!.label).toBe("H1");
    expect(h.seats.at(-1)!.label).toBe("H19");
    // Aisle between H12 and H13.
    expect(segments(h).map((s) => s.map((x) => x.number).join(","))).toEqual(["1,2,3,4,5,6,7,8,9,10,11,12", "13,14,15,16,17,18,19"]);
  });
  it("aligns rows: B1 under A1 (wheelchair), A10 over B12", () => {
    const at = (lab: string) => l.rows.flatMap((r) => r.seats).find((s) => s.label === lab)!;
    expect(at("A1").x).toBe(at("B1").x);
    expect(at("A10").x).toBe(at("B12").x);
    expect(at("A1").state).toBe("wheelchair");
    expect(at("A10").state).toBe("wheelchair");
    expect(at("A2").x).toBe(at("B3").x);
  });
  it("counts and chain coordinates", () => {
    expect(l.counts).toMatchObject({ available: 103, wheelchair: 2, taken: 0 });
    expect(l.maxQuantity).toBe(10);
    const f7 = l.rows.find((r) => r.name === "F")!.seats.find((s) => s.number === "7")!;
    expect(f7.ref).toEqual({ areaNumber: expect.any(Number), rowIndex: 2, columnIndex: 8 });
  });
  it("treats unknown statuses as taken and reports them", () => {
    const mutated = structuredClone(raw);
    mutated.seats.seatLayoutData.areas[0].rows[0].seats[0].status = "Quantum";
    const m = mapSeatLayout(SeatsSchema.parse(mutated));
    expect(m.unknownStatuses).toEqual(["Quantum"]);
    expect(m.counts.taken).toBe(1);
  });
});

describe("proposeSeats", () => {
  it("regular: center columns, middle-to-lower rows", () => {
    const p = proposeSeats(room(), 2, { mode: "regular" });
    expect(p.contiguous).toBe(true);
    const rowIdx = "ABCDEFGHIJ".indexOf(p.seats[0]!.row);
    expect(rowIdx).toBeGreaterThanOrEqual(3);
    expect(rowIdx).toBeLessThanOrEqual(4);
    expect(p.seats.map((s) => Number(s.number))).toEqual([7, 8]);
  });
  it("premium: center, upper rows", () => {
    const p = proposeSeats(room(), 2, { mode: "premium" });
    const rowIdx = "ABCDEFGHIJ".indexOf(p.seats[0]!.row);
    expect(rowIdx).toBeGreaterThanOrEqual(6);
    expect(rowIdx).toBeLessThanOrEqual(7);
  });
  it("keeps groups together and never crosses an aisle", () => {
    const p = proposeSeats(room(10, 14, 7), 4, { mode: "regular" });
    expect(p.contiguous).toBe(true);
    const xs = p.seats.map((s) => s.x);
    expect(xs.every((x, i) => i === 0 || x === xs[i - 1]! + 1)).toBe(true);
  });
  it("never leaves a single stranded seat next to the block", () => {
    // Row E: only E5..E8 free between taken seats -> a 3-block would strand one seat.
    let l = room(10, 14);
    const allButE5to8 = l.rows.flatMap((r) => r.seats).filter((s) => !(s.row === "E" && +s.number >= 5 && +s.number <= 8)).map((s) => s.label);
    l = withTaken(l, allButE5to8);
    const three = proposeSeats(l, 3, { mode: "regular" });
    expect(three.seats).toEqual([]);
    const two = proposeSeats(l, 2, { mode: "regular" });
    expect(two.seats).toHaveLength(2);
    expect(strandedSeats(l.rows[4]!, new Set(two.seats.map((s) => s.label)))).toEqual([]);
  });
  it("skips wheelchair spaces unless asked", () => {
    const l = sala6();
    const all = proposeSeats(withTaken(l, l.rows.flatMap((r) => r.seats).filter((s) => s.row !== "A").map((s) => s.label)), 1, { mode: "regular" });
    expect(all.seats.every((s) => s.state === "available")).toBe(true);
  });
  it("splits into two groups only when no contiguous block exists", () => {
    let l = room(3, 4);
    // Leave only pairs free: A1-A2 and C3-C4.
    l = withTaken(l, l.rows.flatMap((r) => r.seats).filter((s) => !["A1", "A2", "C3", "C4"].includes(s.label)).map((s) => s.label));
    const p = proposeSeats(l, 4, { mode: "regular" });
    expect(p.contiguous).toBe(false);
    expect(p.seats).toHaveLength(4);
    expect(p.note).toMatch(/dos grupos/);
  });
  it("picks a block centered on the screen in Sala 6", () => {
    // Screen center is x=9.5 (room spans H1..H19); D5-D6 straddle it.
    const p = proposeSeats(sala6(), 2, { mode: "regular" });
    expect(p.seats.map((s) => s.label)).toEqual(["D5", "D6"]);
  });
});

describe("validateSeats", () => {
  const l = withTaken(sala6(), ["F9"]);
  it("parses loose input", () => {
    expect(parseSeatLabels("f7, F8 ; g-10")).toEqual(["F7", "F8", "G10"]);
  });
  it("accepts a valid pair", () => {
    expect(validateSeats(l, ["F7", "F8"], { tickets: 2 })).toMatchObject({ ok: true, errors: [] });
    expect(validateSeats(l, ["F5", "F6"], { tickets: 2 }).ok).toBe(true);
  });
  it("rejects taken, missing, wrong count and stranded seats", () => {
    expect(validateSeats(l, ["F9"]).errors.join()).toMatch(/ocupado/);
    expect(validateSeats(l, ["Z1"]).errors.join()).toMatch(/no existe/);
    expect(validateSeats(l, ["F7"], { tickets: 2 }).errors.join()).toMatch(/2 boleto/);
    // F8 would sit alone between F7 (chosen) and F9 (taken).
    expect(validateSeats(l, ["F6", "F7"]).errors.join()).toMatch(/F8 solo/);
    // Row end: choosing F2 strands F1.
    expect(validateSeats(l, ["F2", "F3"]).errors.join()).toMatch(/F1 solo/);
    expect(validateSeats(l, ["A1"]).errors.join()).toMatch(/silla de ruedas/);
  });
  it("warns (or errors if the cinema requires it) when not together", () => {
    expect(validateSeats(l, ["C3", "E3"]).warnings.join()).toMatch(/no están juntos/);
    expect(validateSeats({ ...l, requireContiguous: true }, ["C3", "E3"]).ok).toBe(false);
  });
});

describe("mode and experience", () => {
  const c = (isVip: boolean) => ({ isVip }) as any;
  it("uses premium rows for VIP and premium formats", () => {
    expect(proposalMode(c(true), undefined)).toBe("premium");
    expect(proposalMode(c(false), { experience: "IMAX" } as any)).toBe("premium");
    expect(proposalMode(c(false), { experience: "SJ" } as any)).toBe("regular");
    expect(proposalMode(c(false), {} as any)).toBe("regular");
  });
  it("asks the API for the right seat area", () => {
    expect(seatExperience(c(true), {} as any)).toBe("VIP");
    expect(seatExperience(c(false), { experience: "4DX" } as any)).toBe("4DX");
    expect(seatExperience(c(false), {} as any)).toBe("TRADICIONAL");
  });
});

describe("render", () => {
  const svg = renderSeatMapSvg(withTaken(sala6(), ["F9", "G1"]), { title: "Parque Toreo", subtitle: "2026-10-20 19:00 · Subtitulada · 2D", screenLabel: "PANTALLA · SALA 6", proposed: ["D6", "D7"] });
  it("matches the golden SVG", () => {
    const golden = new URL("./golden/sala6.svg", import.meta.url);
    if (!existsSync(golden) || process.env.UPDATE_GOLDEN === "1") {
      mkdirSync(new URL("./golden/", import.meta.url), { recursive: true });
      writeFileSync(golden, svg);
    }
    expect(svg).toBe(readFileSync(golden, "utf8"));
  });
  it("renders a PNG", () => {
    const png = svgToPng(svg);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBeGreaterThan(1000);
  });
  it("escapes text", () => {
    expect(renderSeatMapSvg(sala6(), { title: "<b>&" })).toContain("&lt;b&gt;&amp;");
  });
});
