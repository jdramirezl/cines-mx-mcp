/**
 * MCP tools that act on the user's behalf: hold/release seats, purchase,
 * secure input and session status. Hold and purchase are approval-gated in
 * the hub (destructiveHint: true); the server enforces its own guardrails.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { publicHold, type HoldService } from "./cinepolis/orders.js";
import { CinesError } from "./errors.js";
import { approvalRequired, capMxn, purchase, type PaymentDriver, type PurchaseLedger } from "./order/purchase.js";
import { parseSeatLabels, validateSeats } from "./seats.js";
import { resolveShowtime, seatExperience } from "./seatTools.js";
import { runUntilInput, type SecureInputBroker } from "./secure.js";
import type { SessionManager } from "./session/session.js";
import { fail, ok, type ToolContext } from "./tools.js";

export interface OrderToolContext extends ToolContext {
  holds: HoldService;
  session: SessionManager;
  broker: SecureInputBroker;
  ledger: PurchaseLedger;
  driver: PaymentDriver;
  dryRunDriver?: PaymentDriver;
  /** How long a tool waits before returning `in_progress` (default 110 s). */
  waitMs?: number;
}

const ACTS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const SAFE_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function needsInput(r: { requestId: string; kind: string; prompt: string; expiresAt: string; imageUrl?: string }) {
  return ok({ status: "needs_input", requestId: r.requestId, kind: r.kind, prompt: r.prompt, expiresAt: r.expiresAt, imageUrl: r.imageUrl, secure: true });
}

/** Background jobs started by tools that paused for secure input; resolved by cines_secure_input. */
const jobs = new Map<string, Promise<unknown>>();

export function registerOrderTools(server: McpServer, ctx: OrderToolContext): void {
  const waitMs = ctx.waitMs ?? 110_000;

  /** Run work; if it pauses for secure input, park it and return needs_input. */
  async function runInteractive(work: () => Promise<unknown>) {
    const r = await runUntilInput(ctx.broker, work, { waitMs });
    if (r.done) return ok(r.value);
    if (r.request) {
      jobs.set(r.request.requestId, r.job);
      return needsInput(r.request);
    }
    const id = `job_${Date.now().toString(36)}`;
    jobs.set(id, r.job);
    return ok({ status: "in_progress", jobId: id, note: "Sigue en curso; consulta con cines_hold_status." });
  }

  server.registerTool(
    "cines_hold_seats",
    {
      title: "Hold seats (approval required)",
      description:
        "Reserve (apartar) the chosen seats for a showtime under the user's Cinépolis account for ~9 minutes, without paying. Requires the user's approval. Validates the seats first. Default ticket type 'Admision General'. Returns holdId, seats, ticket type and the exact total with fees, plus `purchaseApprovalRequired`. May return status 'needs_input' (kind 'email_code') if Cinépolis asks for a login code: the hub must collect it via secure input and call cines_secure_input.",
      inputSchema: {
        showtimeId: z.string(),
        seats: z.string().describe("e.g. 'F7,F8' (validated with the same rules as cines_validate_seats)"),
        ticketType: z.string().optional().describe("Only if the user asked for a specific type (e.g. 'Que Oferton 2026')"),
        wheelchair: z.boolean().optional(),
      },
      annotations: ACTS,
    },
    async ({ showtimeId, seats, ticketType, wheelchair }) => {
      try {
        return await runInteractive(async () => {
          const r = await resolveShowtime(ctx, showtimeId);
          if (!r.cinema || !r.showtime) throw new CinesError("CINES_NOT_FOUND", "No encontré esa función en tus cines.");
          const layout = await ctx.provider.getSeatLayout({
            cinemaVistaId: r.vistaId,
            sessionId: r.sessionId,
            experience: seatExperience(r.cinema, r.showtime),
            requireContiguous: r.cinema.requireContiguousSeating,
          });
          const labels = parseSeatLabels(seats);
          const v = validateSeats(layout, labels, { allowWheelchair: wheelchair });
          if (!v.ok) throw new CinesError("CINES_BAD_REQUEST", v.errors.join(" "));
          const index = new Map(layout.rows.flatMap((row) => row.seats.map((s) => [s.label, s] as const)));
          const movie = await ctx.provider.getMovie(r.showtime.movieId).catch(() => undefined);
          const accessToken = await ctx.session.getAccessToken();
          const hold = await ctx.holds.hold({
            cinema: r.cinema,
            showtime: r.showtime,
            movie: { name: movie?.title ?? r.showtime.movieId, image: movie?.posterUrl },
            layout,
            seats: v.seats.map((l) => index.get(l)!),
            ticketType,
            defaultTicketType: ctx.profile.preferences.defaultTicketType,
            accessToken,
          });
          return {
            ...publicHold(hold),
            status: "held",
            movie: movie?.title,
            purchaseApprovalRequired: approvalRequired(ctx.ledger),
            capMxn: capMxn(),
            warnings: v.warnings.length ? v.warnings : undefined,
            next: "Muestra el resumen. Para pagar llama cines_purchase con holdId y expectedTotalMxn = totalMxn; para cancelar, cines_release_hold.",
          };
        });
      } catch (e) {
        if (e instanceof CinesError && e.code === "CINES_SESSION_EXPIRED") ctx.session.invalidate();
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cines_release_hold",
    {
      title: "Release held seats",
      description: "Release (liberar) the currently held seats, or a specific holdId. Safe; no approval needed.",
      inputSchema: { holdId: z.string().optional() },
      annotations: SAFE_WRITE,
    },
    async ({ holdId }) => {
      try {
        const h = await ctx.holds.release(holdId);
        return ok(h ? { status: h.status, holdId: h.holdId, seats: h.seats } : { status: "none", note: "No había asientos apartados." });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cines_hold_status",
    {
      title: "Current hold, purchase and session status",
      description: "The active seat hold (if any) with time left, pending secure-input requests, recent purchases and the Cinépolis session state.",
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      try {
        const h = ctx.holds.active();
        return ok({
          hold: h ? { ...publicHold(h), secondsLeft: Math.max(0, Math.round((Date.parse(h.expiresAt) - Date.now()) / 1000)) } : null,
          pendingInput: ctx.broker.list(),
          purchases: ctx.ledger.recent(3).map((e) => ({ at: e.at, totalMxn: e.totalMxn, status: e.status, bookingNumber: e.bookingNumber, dryRun: e.dryRun })),
          successfulPurchases: ctx.ledger.successes(),
          purchaseApprovalRequired: approvalRequired(ctx.ledger),
          session: ctx.session.status(),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cines_purchase",
    {
      title: "Pay for held seats (approval required)",
      description:
        "Pay for a hold. Hard cap $1,000 MXN. `expectedTotalMxn` must equal the hold's totalMxn shown to the user. While fewer than 3 purchases have succeeded, `userApproved: true` is required (only after the user tapped ✅). Never retried. May return status 'needs_input' (kind 'cvv' or 'otp_3ds') — the hub collects it via secure input and calls cines_secure_input. `dryRun: true` simulates without paying.",
      inputSchema: {
        holdId: z.string(),
        expectedTotalMxn: z.number().positive(),
        method: z.enum(["paypal", "card"]).optional().describe("Default paypal; card = card saved in the Cinépolis/DEUNA wallet"),
        userApproved: z.boolean().optional(),
        dryRun: z.boolean().optional(),
      },
      annotations: ACTS,
    },
    async (args) => {
      try {
        return await runInteractive(() =>
          purchase(args, {
            holds: ctx.holds,
            ledger: ctx.ledger,
            driver: ctx.driver,
            dryRunDriver: ctx.dryRunDriver,
            cap: capMxn(),
            ask: (kind, prompt, imageUrl) => ctx.broker.ask(kind, prompt, { imageUrl }),
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cines_secure_input",
    {
      title: "Deliver a secret the user typed (hub only)",
      description:
        "HUB ONLY — must not be exposed to the language model. Delivers the user's reply to a pending secure-input request (requestId from a 'needs_input' result) and continues the paused operation, returning its next result (final, or another needs_input). The value is never logged or returned.",
      inputSchema: { requestId: z.string(), value: z.string().min(1).max(32) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ requestId, value }) => {
      try {
        const job = jobs.get(requestId);
        ctx.broker.submit(requestId, value);
        if (!job) return ok({ status: "accepted" });
        jobs.delete(requestId);
        return await runInteractive(() => job);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
