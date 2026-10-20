/** MCP seat tools: seat map with proposal, and seat-choice validation with preview. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EXPERIENCE_LABEL, type Cinema, type Showtime } from "./domain.js";
import { CinesError } from "./errors.js";
import type { ImageStore } from "./images.js";
import { renderSeatMapSvg, svgToPng } from "./render.js";
import { parseSeatLabels, proposeSeats, validateSeats, type ProposalMode, type SeatLayout } from "./seats.js";
import { fail, ok, type ToolContext } from "./tools.js";

export interface SeatToolContext extends ToolContext {
  images: ImageStore;
  /** e.g. http://127.0.0.1:8686 (resolved at request time). */
  baseUrl: () => string;
}

const PREMIUM = new Set(["IMAX", "XE", "4DX", "SCREENX"]);

export function proposalMode(cinema: Cinema | undefined, s: Showtime | undefined): ProposalMode {
  if (cinema?.isVip) return "premium";
  if (s?.experience && PREMIUM.has(s.experience)) return "premium";
  return "regular";
}

export function seatExperience(cinema: Cinema | undefined, s: Showtime | undefined): string {
  if (s?.experience && s.experience !== "SJ") return s.experience;
  return cinema?.isVip ? "VIP" : "TRADICIONAL";
}

interface Resolved {
  showtime?: Showtime;
  cinema?: Cinema;
  vistaId: string;
  sessionId: string;
}

/** `showtimeId` is `<cinemaVistaId>-<sessionId>` as returned by the read tools. */
export async function resolveShowtime(ctx: ToolContext, showtimeId: string): Promise<Resolved> {
  const m = /^(\d+)-(\d+)$/.exec(showtimeId.trim());
  if (!m) throw new CinesError("CINES_BAD_REQUEST", `showtimeId inválido "${showtimeId}" (usa el de cines_showtimes / cines_best_showtime)`);
  const [, vistaId, sessionId] = m as unknown as [string, string, string];
  const cinemas = await ctx.provider.getCinemas(ctx.profile.cinemas.map((c) => c.id));
  const cinema = cinemas.find((c) => c.vistaId === vistaId);
  let showtime: Showtime | undefined;
  if (cinema) showtime = (await ctx.provider.getShowtimesByCinema(cinema.id)).find((s) => s.sessionId === sessionId);
  return { showtime, cinema, vistaId, sessionId };
}

function header(ctx: ToolContext, r: Resolved, layout: SeatLayout): { title: string; subtitle: string; screen: string } {
  const label = ctx.profile.cinemas.find((c) => c.id === r.cinema?.id)?.label ?? r.cinema?.name ?? `Cine ${r.vistaId}`;
  const s = r.showtime;
  const fmt = s ? (s.experience ? (EXPERIENCE_LABEL[s.experience] ?? s.experience) : s.format) : "";
  const when = s ? `${s.date} ${s.time}` : "";
  return {
    title: label,
    subtitle: [when, s?.language === "SUB" ? "Subtitulada" : s?.language === "ESP" ? "Doblada" : s?.languageLabel, fmt, layout.areaName].filter(Boolean).join(" · "),
    screen: s?.screen ? `PANTALLA · SALA ${s.screen}` : "PANTALLA",
  };
}

function publish(ctx: SeatToolContext, svg: string): string {
  const id = ctx.images.put(svgToPng(svg));
  return `${ctx.baseUrl()}/images/${id}.png`;
}

export function registerSeatTools(server: McpServer, ctx: SeatToolContext): void {
  server.registerTool(
    "cines_seat_map",
    {
      title: "Seat map with proposed seats",
      description:
        "Live seat map for a showtime with the best seats proposed for the party (regular rooms: center, middle-to-lower rows; VIP/IMAX/premium: center, upper rows; groups together; prefers not to leave single empty seats). Returns `imageUrl` (PNG to send to the user), the proposal like ['F7','F8'] and availability counts. Does NOT hold seats. The user may reply with other seats; check them with cines_validate_seats.",
      inputSchema: {
        showtimeId: z.string().describe("From cines_showtimes / cines_best_showtime, e.g. 570-102599"),
        tickets: z.number().int().min(1).max(10).optional().describe("Party size; default 1"),
        wheelchair: z.boolean().optional().describe("Allow wheelchair spaces (only if the user needs them)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ showtimeId, tickets, wheelchair }) => {
      try {
        const r = await resolveShowtime(ctx, showtimeId);
        const layout = await ctx.provider.getSeatLayout({
          cinemaVistaId: r.vistaId,
          sessionId: r.sessionId,
          experience: seatExperience(r.cinema, r.showtime),
          requireContiguous: r.cinema?.requireContiguousSeating,
        });
        const n = tickets ?? ctx.profile.preferences.defaultTickets;
        if (n > layout.maxQuantity) throw new CinesError("CINES_BAD_REQUEST", `Máximo ${layout.maxQuantity} boletos por compra.`);
        const mode = proposalMode(r.cinema, r.showtime);
        const proposal = proposeSeats(layout, n, { mode, allowWheelchair: wheelchair });
        const h = header(ctx, r, layout);
        const imageUrl = publish(ctx, renderSeatMapSvg(layout, { title: h.title, subtitle: h.subtitle, screenLabel: h.screen, proposed: proposal.seats.map((s) => s.label) }));
        return ok({
          showtimeId,
          imageUrl,
          proposal: proposal.seats.map((s) => s.label),
          together: proposal.contiguous,
          note: proposal.note,
          mode: mode === "premium" ? "centro, filas altas" : "centro, filas medias-bajas",
          available: layout.counts.available,
          taken: layout.counts.taken,
          rows: `${layout.rows.at(0)?.name ?? "?"} (frente) → ${layout.rows.at(-1)?.name ?? "?"} (atrás)`,
          warnings: layout.unknownStatuses.length ? [`Estados de asiento desconocidos: ${layout.unknownStatuses.join(", ")} (tratados como ocupados)`] : undefined,
          next: "Muestra la imagen; si el usuario elige otros asientos, valida con cines_validate_seats.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cines_validate_seats",
    {
      title: "Validate the user's seat choice",
      description:
        "Check seats the user typed (e.g. 'F7,F8') against the live map: they exist, are free, match the ticket count, sit together, and warns if a single empty seat would be left (allowed in Mexico). Returns errors/warnings and a preview `imageUrl` with the choice highlighted. Does NOT hold seats.",
      inputSchema: {
        showtimeId: z.string(),
        seats: z.string().describe("Seat labels, e.g. 'F7,F8'"),
        tickets: z.number().int().min(1).max(10).optional(),
        wheelchair: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ showtimeId, seats, tickets, wheelchair }) => {
      try {
        const r = await resolveShowtime(ctx, showtimeId);
        const layout = await ctx.provider.getSeatLayout({
          cinemaVistaId: r.vistaId,
          sessionId: r.sessionId,
          experience: seatExperience(r.cinema, r.showtime),
          requireContiguous: r.cinema?.requireContiguousSeating,
        });
        const v = validateSeats(layout, parseSeatLabels(seats), { tickets, allowWheelchair: wheelchair });
        const h = header(ctx, r, layout);
        const imageUrl = publish(ctx, renderSeatMapSvg(layout, { title: h.title, subtitle: h.subtitle, screenLabel: h.screen, selected: v.ok ? v.seats : v.seats.filter((l) => !v.errors.some((e) => e.startsWith(l))) }));
        return ok({ showtimeId, ok: v.ok, seats: v.seats, errors: v.errors.length ? v.errors : undefined, warnings: v.warnings.length ? v.warnings : undefined, imageUrl });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
