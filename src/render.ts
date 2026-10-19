/**
 * Seat map rendering: SVG (deterministic, golden-tested) -> PNG via resvg.
 * Screen at the top, row letters on both sides, seat numbers, colors for
 * available / taken / wheelchair / proposed / selected.
 */
import { Resvg } from "@resvg/resvg-js";
import type { Seat, SeatLayout } from "./seats.js";

export const COLORS = {
  bg: "#FFFFFF",
  ink: "#15274D",
  muted: "#8892A6",
  available: { fill: "#FFFFFF", stroke: "#8892A6", text: "#15274D" },
  taken: { fill: "#D5DAE2", stroke: "#D5DAE2", text: "#9AA3B2" },
  blocked: { fill: "#EEF0F4", stroke: "#EEF0F4", text: "#C2C8D2" },
  wheelchair: { fill: "#E3ECFF", stroke: "#4F7DF3", text: "#4F7DF3" },
  proposed: { fill: "#FFBE06", stroke: "#C99400", text: "#15274D" },
  selected: { fill: "#4F7DF3", stroke: "#2F5BD3", text: "#FFFFFF" },
} as const;

export interface RenderOptions {
  title?: string;
  subtitle?: string;
  screenLabel?: string;
  proposed?: string[];
  selected?: string[];
}

const CELL = 30;
const GAP = 6;
const PAD = 24;
const LABEL_W = 30;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function style(seat: Seat, proposed: Set<string>, selected: Set<string>) {
  if (selected.has(seat.label)) return COLORS.selected;
  if (proposed.has(seat.label)) return COLORS.proposed;
  if (seat.state === "taken") return COLORS.taken;
  if (seat.state === "blocked") return COLORS.blocked;
  if (seat.state === "wheelchair" || seat.state === "companion") return COLORS.wheelchair;
  return COLORS.available;
}

export function renderSeatMapSvg(layout: SeatLayout, opts: RenderOptions = {}): string {
  const proposed = new Set(opts.proposed ?? []);
  const selected = new Set(opts.selected ?? []);
  const cols = layout.maxX - layout.minX + 1;
  const gridW = cols * CELL + (cols - 1) * GAP;
  const width = PAD * 2 + LABEL_W * 2 + gridW;
  const headerH = (opts.title ? 30 : 0) + (opts.subtitle ? 22 : 0);
  const screenY = PAD + headerH;
  const gridY = screenY + 46;
  const rowsH = layout.rows.length * CELL + Math.max(0, layout.rows.length - 1) * GAP;
  const legendY = gridY + rowsH + 30;
  const height = legendY + 40;
  const gx = (x: number) => PAD + LABEL_W + (x - layout.minX) * (CELL + GAP);
  const gy = (i: number) => gridY + i * (CELL + GAP);
  const font = `font-family="Helvetica, Arial, sans-serif"`;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  out.push(`<rect width="100%" height="100%" fill="${COLORS.bg}"/>`);
  let ty = PAD;
  if (opts.title) {
    out.push(`<text x="${width / 2}" y="${ty + 20}" ${font} font-size="20" font-weight="700" fill="${COLORS.ink}" text-anchor="middle">${esc(opts.title)}</text>`);
    ty += 30;
  }
  if (opts.subtitle) {
    out.push(`<text x="${width / 2}" y="${ty + 15}" ${font} font-size="14" fill="${COLORS.muted}" text-anchor="middle">${esc(opts.subtitle)}</text>`);
  }
  out.push(`<rect x="${PAD + LABEL_W}" y="${screenY}" width="${gridW}" height="26" rx="13" fill="#C7CDD6"/>`);
  out.push(
    `<text x="${PAD + LABEL_W + gridW / 2}" y="${screenY + 18}" ${font} font-size="14" font-weight="700" fill="${COLORS.ink}" text-anchor="middle">${esc(opts.screenLabel ?? "PANTALLA")}</text>`,
  );
  layout.rows.forEach((row, i) => {
    const y = gy(i);
    for (const lx of [PAD + LABEL_W / 2 - 4, PAD + LABEL_W + gridW + LABEL_W / 2 + 4]) {
      out.push(`<text x="${lx}" y="${y + CELL / 2 + 6}" ${font} font-size="18" font-weight="700" fill="${COLORS.ink}" text-anchor="middle">${esc(row.name)}</text>`);
    }
    for (const s of row.seats) {
      const c = style(s, proposed, selected);
      const x = gx(s.x);
      out.push(`<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="7" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>`);
      const label = s.state === "wheelchair" && !proposed.has(s.label) && !selected.has(s.label) ? `♿${s.number}` : s.number;
      const size = label.length > 2 ? 10 : 13;
      out.push(`<text x="${x + CELL / 2}" y="${y + CELL / 2 + size / 2 - 1}" ${font} font-size="${size}" font-weight="700" fill="${c.text}" text-anchor="middle">${esc(label)}</text>`);
    }
  });
  const legend: [string, { fill: string; stroke: string }][] = [
    ["Disponible", COLORS.available],
    ["Ocupado", COLORS.taken],
    ["Silla de ruedas", COLORS.wheelchair],
    ["Propuesta", COLORS.proposed],
    ["Elegido", COLORS.selected],
  ];
  const itemW = 150;
  const perRow = Math.max(1, Math.min(legend.length, Math.floor((width - PAD * 2) / itemW)));
  legend.forEach(([name, c], i) => {
    const rowN = Math.floor(i / perRow);
    const inRow = Math.min(perRow, legend.length - rowN * perRow);
    const lx0 = Math.max(PAD, (width - inRow * itemW) / 2);
    const x = lx0 + (i % perRow) * itemW;
    const y = legendY + rowN * 28;
    out.push(`<rect x="${x}" y="${y}" width="18" height="18" rx="4" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>`);
    out.push(`<text x="${x + 26}" y="${y + 14}" ${font} font-size="13" fill="${COLORS.ink}">${name}</text>`);
  });
  out.push("</svg>");
  const legendRows = Math.ceil(legend.length / perRow);
  out[0] = out[0]!.replace(`height="${height}"`, `height="${height + (legendRows - 1) * 28}"`).replace(` ${height}"`, ` ${height + (legendRows - 1) * 28}"`);
  return out.join("\n");
}

export function svgToPng(svg: string, scale = 2): Buffer {
  const width = Number(/width="(\d+)"/.exec(svg)?.[1] ?? 800);
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: Math.round(width * scale) },
    font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" },
    background: "#FFFFFF",
  });
  return Buffer.from(r.render().asPng());
}
