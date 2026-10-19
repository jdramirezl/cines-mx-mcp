/**
 * Seat layout model, seat proposal and validation. Chain-independent and pure.
 *
 * Geometry: `y` = 0 is the row closest to the screen; `x` grows left to right
 * as seen from the seats facing the screen (the way the site draws it). Gaps in
 * `x` are aisles.
 */

export type SeatState = "available" | "taken" | "wheelchair" | "companion" | "blocked";

export interface Seat {
  /** Row letter + seat number, e.g. "F7". */
  label: string;
  row: string;
  number: string;
  x: number;
  y: number;
  state: SeatState;
  areaCode: string;
  /** Chain coordinates needed to hold the seat later. */
  ref: { areaNumber: number; rowIndex: number; columnIndex: number };
}

export interface SeatRow {
  name: string;
  y: number;
  seats: Seat[];
}

export interface SeatLayout {
  areaName: string;
  areaCode: string;
  /** Front (screen side) first. */
  rows: SeatRow[];
  minX: number;
  maxX: number;
  maxQuantity: number;
  requireContiguous: boolean;
  /** Raw statuses we did not recognize (treated as taken). */
  unknownStatuses: string[];
  counts: Record<SeatState, number>;
}

export type ProposalMode = "regular" | "premium";

export interface Proposal {
  seats: Seat[];
  contiguous: boolean;
  note?: string;
}

/** Row position as a fraction: 0 = front row, 1 = back row. */
const frac = (layout: SeatLayout, y: number) => (layout.rows.length <= 1 ? 0.5 : y / (layout.rows.length - 1));

/** Target row: regular = middle-to-lower (stadium seating is already high); premium = upper-middle. */
export const ROW_TARGET: Record<ProposalMode, number> = { regular: 0.42, premium: 0.72 };

function selectable(s: Seat, allowWheelchair: boolean): boolean {
  return s.state === "available" || (allowWheelchair && s.state === "wheelchair");
}

/** Maximal runs of seats with consecutive x in a row (aisles split segments). */
export function segments(row: SeatRow): Seat[][] {
  const sorted = [...row.seats].sort((a, b) => a.x - b.x);
  const out: Seat[][] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s.x === last.at(-1)!.x + 1) last.push(s);
    else out.push([s]);
  }
  return out;
}

/**
 * Cinépolis rule: do not leave a single empty seat between your seats and
 * another occupied seat or the end of the block. Returns the stranded seats.
 */
export function strandedSeats(row: SeatRow, chosen: Set<string>): Seat[] {
  const out: Seat[] = [];
  for (const seg of segments(row)) {
    const free = (s: Seat) => !chosen.has(s.label) && (s.state === "available" || s.state === "wheelchair" || s.state === "companion");
    for (let i = 0; i < seg.length; i++) {
      const s = seg[i]!;
      if (!free(s)) continue;
      const left = seg[i - 1];
      const right = seg[i + 1];
      const leftClosed = !left || !free(left);
      const rightClosed = !right || !free(right);
      const touchesChoice = (left && chosen.has(left.label)) || (right && chosen.has(right.label));
      if (leftClosed && rightClosed && touchesChoice) out.push(s);
    }
  }
  return out;
}

function scoreBlock(layout: SeatLayout, block: Seat[], mode: ProposalMode): number {
  const center = (layout.minX + layout.maxX) / 2;
  const half = Math.max(1, (layout.maxX - layout.minX) / 2);
  const bx = (block[0]!.x + block.at(-1)!.x) / 2;
  const f = frac(layout, block[0]!.y);
  let score = Math.abs(f - ROW_TARGET[mode]) * 1.0 + (Math.abs(bx - center) / half) * 1.2;
  if (f < 0.15) score += 0.6; // first rows: neck strain
  if (mode === "regular" && f > 0.95) score += 0.2;
  return score;
}

export interface ProposeOptions {
  mode: ProposalMode;
  allowWheelchair?: boolean;
}

/** Best contiguous block for `n` seats; falls back to split groups only when impossible. */
export function proposeSeats(layout: SeatLayout, n: number, opts: ProposeOptions): Proposal {
  const allowW = opts.allowWheelchair ?? false;
  type Cand = { block: Seat[]; score: number };
  const cands: Cand[] = [];
  for (const row of layout.rows) {
    for (const seg of segments(row)) {
      for (let i = 0; i + n <= seg.length; i++) {
        const block = seg.slice(i, i + n);
        if (!block.every((s) => selectable(s, allowW))) continue;
        if (strandedSeats(row, new Set(block.map((s) => s.label))).length) continue;
        cands.push({ block, score: scoreBlock(layout, block, opts.mode) });
      }
    }
  }
  cands.sort((a, b) => a.score - b.score);
  if (cands[0]) return { seats: cands[0].block, contiguous: true };

  // Impossible to sit together: split into two groups in nearby rows.
  if (n >= 2) {
    const a = Math.ceil(n / 2);
    const first = proposeSeats(layout, a, opts);
    if (first.contiguous) {
      const taken = new Set(first.seats.map((s) => s.label));
      const rest: SeatLayout = {
        ...layout,
        rows: layout.rows.map((r) => ({ ...r, seats: r.seats.map((s) => (taken.has(s.label) ? { ...s, state: "taken" as const } : s)) })),
      };
      const second = proposeSeats(rest, n - a, opts);
      if (second.seats.length === n - a) {
        return { seats: [...first.seats, ...second.seats], contiguous: false, note: "No hay asientos juntos para todos; propuesta en dos grupos." };
      }
    }
  }
  return { seats: [], contiguous: false, note: `No hay ${n} asientos disponibles que cumplan las reglas.` };
}

export interface Validation {
  ok: boolean;
  seats: string[];
  errors: string[];
  warnings: string[];
}

/** Parse "F7, F8" / "f7 f8" / "F-7". */
export function parseSeatLabels(input: string | string[]): string[] {
  const text = Array.isArray(input) ? input.join(",") : input;
  return [...text.matchAll(/([A-Za-z]{1,2})\s*-?\s*(\d{1,3})/g)].map((m) => `${m[1]!.toUpperCase()}${Number(m[2])}`);
}

export function validateSeats(layout: SeatLayout, labels: string[], opts: { tickets?: number; allowWheelchair?: boolean } = {}): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const index = new Map(layout.rows.flatMap((r) => r.seats.map((s) => [s.label, s] as const)));
  const uniq = [...new Set(labels)];
  if (uniq.length !== labels.length) warnings.push("Asientos repetidos ignorados.");
  if (!uniq.length) errors.push("No reconocí ningún asiento. Usa el formato F7,F8.");
  const seats: Seat[] = [];
  for (const l of uniq) {
    const s = index.get(l);
    if (!s) errors.push(`${l} no existe en esta sala.`);
    else if (s.state === "taken" || s.state === "blocked") errors.push(`${l} está ocupado.`);
    else if ((s.state === "wheelchair" || s.state === "companion") && !opts.allowWheelchair) {
      errors.push(`${l} es un lugar para silla de ruedas/acompañante; Cinépolis te reubica si no lo necesitas.`);
    } else seats.push(s);
  }
  if (opts.tickets !== undefined && uniq.length !== opts.tickets) errors.push(`Elegiste ${uniq.length} asiento(s) para ${opts.tickets} boleto(s).`);
  if (layout.maxQuantity && uniq.length > layout.maxQuantity) errors.push(`Máximo ${layout.maxQuantity} asientos por compra.`);
  if (seats.length === uniq.length && seats.length > 1) {
    const sameRow = new Set(seats.map((s) => s.y)).size === 1;
    const xs = seats.map((s) => s.x).sort((a, b) => a - b);
    const adjacent = sameRow && xs.every((x, i) => i === 0 || x === xs[i - 1]! + 1);
    if (!adjacent) (layout.requireContiguous ? errors : warnings).push("Los asientos no están juntos.");
  }
  const chosen = new Set(seats.map((s) => s.label));
  for (const row of layout.rows) {
    if (!row.seats.some((s) => chosen.has(s.label))) continue;
    for (const s of strandedSeats(row, chosen)) errors.push(`Dejarías ${s.label} solo; Cinépolis no permite asientos sueltos entre tu selección y otro ocupado.`);
  }
  return { ok: errors.length === 0, seats: uniq, errors, warnings };
}
