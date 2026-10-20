/**
 * MCP tools that act on the user's behalf: hold/release seats, purchase,
 * secure input and session status. Hold and purchase are approval-gated in
 * the hub (destructiveHint: true); the server enforces its own guardrails.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { ImageStore } from "./images.js";
import type { PaymentArm } from "./order/arm.js";
import type { PinArm } from "./order/pin.js";
import { publicHold, type HoldService } from "./cinepolis/orders.js";
import { CinesError, toErrorShape } from "./errors.js";
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
  arm?: PaymentArm;
  pin?: PinArm;
  images?: ImageStore;
  baseUrl?: () => string;
  /** How long a tool waits before returning `in_progress` (default 110 s). */
  waitMs?: number;
  /** Same for holds (default 40 s, must stay under the hub's MCP timeout). */
  holdWaitMs?: number;
}

/** Publish a private confirmation screenshot as a short-lived loopback URL for the hub. */
function publishShot(ctx: OrderToolContext, path?: string): string | undefined {
  if (!path || !ctx.images || !ctx.baseUrl || !existsSync(path)) return undefined;
  return `${ctx.baseUrl()}/images/${ctx.images.put(readFileSync(path))}.png`;
}

const ACTS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const SAFE_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const STATUS_FOR: Record<string, string> = { email_code: "needs_email_code", otp_3ds: "needs_3ds", cvv: "needs_cvv", arm_pin: "needs_arm_pin" };

function needsInput(r: { requestId: string; kind: string; prompt: string; expiresAt: string; imageUrl?: string }) {
  return ok({ status: STATUS_FOR[r.kind] ?? "needs_input", challengeId: r.requestId, kind: r.kind, prompt: r.prompt, expiresAt: r.expiresAt, imageUrl: r.imageUrl, secure: true });
}

/** Background jobs started by tools that paused for secure input; resolved by cines_secure_input. */
const jobs = new Map<string, Promise<unknown>>();

/** Newest background job (in_progress result), visible in cines_hold_status for ~15 min. */
export interface LastJob {
  jobId: string;
  tool: string;
  status: "running" | "done" | "failed";
  error?: { code: string; message: string; retryable: boolean };
  startedAt: string;
  finishedAt?: string;
}
let lastJob: LastJob | undefined;
const LAST_JOB_TTL_MS = 15 * 60_000;

function trackJob(jobId: string, tool: string, job: Promise<unknown>): void {
  const j: LastJob = { jobId, tool, status: "running", startedAt: new Date().toISOString() };
  lastJob = j;
  job.then(
    () => {
      j.status = "done";
      j.finishedAt = new Date().toISOString();
    },
    (e: unknown) => {
      j.status = "failed";
      j.error = toErrorShape(e).error;
      j.finishedAt = new Date().toISOString();
    },
  );
}

export function currentLastJob(now = Date.now()): LastJob | null {
  if (!lastJob) return null;
  const ref = Date.parse(lastJob.finishedAt ?? lastJob.startedAt);
  return now - ref > LAST_JOB_TTL_MS && lastJob.status !== "running" ? null : lastJob;
}

export function registerOrderTools(server: McpServer, ctx: OrderToolContext): void {
  const waitMs = ctx.waitMs ?? 110_000;
  /** Holds must answer well under the hub's MCP timeout (~60 s). */
  const holdWaitMs = Math.min(ctx.holdWaitMs ?? 40_000, waitMs);

  /** Run work; if it pauses for secure input, park it and return needs_input. */
  async function runInteractive(work: () => Promise<unknown>, wait = waitMs, tool = "cines") {
    const r = await runUntilInput(ctx.broker, work, { waitMs: wait });
    if (r.done) return ok(r.value);
    if (r.request) {
      jobs.set(r.request.requestId, r.job);
      return needsInput(r.request);
    }
    const id = `job_${Date.now().toString(36)}`;
    jobs.set(id, r.job);
    trackJob(id, tool, r.job);
    return ok({ status: "in_progress", jobId: id, note: "Sigue en curso; consulta con cines_hold_status." });
  }

  server.registerTool(
    "cines_hold_seats",
    {
      title: "Hold seats (approval required)",
      description:
        "Reserve (apartar) the chosen seats for a showtime under the user's Cinépolis account for ~9 minutes, without paying. Requires the user's approval. Validates the seats first. Default ticket type 'Admision General'. Returns holdId, seats, ticket type and the exact total with fees, plus `purchaseApprovalRequired`. May return status 'needs_email_code' with a challengeId if Cinépolis asks for a login code: the hub collects it via secure input and calls cines_submit_code.",
      inputSchema: {
        showtimeId: z.string(),
        seats: z.union([z.string(), z.array(z.string())]).describe("['F7','F8'] or 'F7,F8' (validated with the same rules as cines_validate_seats)"),
        tickets: z.number().int().min(1).max(10).optional().describe("Party size; must equal the number of seats"),
        ticketType: z.string().optional().describe("Only if the user asked for a specific type (e.g. 'Que Oferton 2026')"),
        wheelchair: z.boolean().optional(),
      },
      annotations: ACTS,
    },
    async ({ showtimeId, seats, tickets, ticketType, wheelchair }) => {
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
          const v = validateSeats(layout, labels, { allowWheelchair: wheelchair, tickets });
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
            cinema: hold.cinemaName,
            movie: movie?.title ?? r.showtime.movieId,
            startsAt: r.showtime.startsAt,
            total: hold.totalMxn,
            currency: "MXN",
            purchaseApprovalRequired: approvalRequired(ctx.ledger),
            capMxn: capMxn(),
            warnings: v.warnings.length ? v.warnings : undefined,
            next: "Muestra el resumen. Para pagar llama cines_purchase con holdId y expectedTotal = total; para cancelar, cines_release_hold.",
          };
        }, holdWaitMs, "cines_hold_seats");
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
          purchases: ctx.ledger.recent(3).map((e) => ({ purchaseId: e.purchaseId, at: e.at, total: e.totalMxn, currency: "MXN", status: e.status, bookingNumber: e.bookingNumber, imageUrl: e.imageUrl, dryRun: e.dryRun })),
          paymentArmed: ctx.arm?.status() ?? { armed: false },
          pinArming: ctx.pin?.status() ?? { configured: false, disabled: false, failures: 0, waitSeconds: 0 },
          lastJob: currentLastJob(),
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
        "Pay for a hold with the card saved in the user's Cinépolis account (default) or PayPal. Hard cap $1,000 MXN. `expectedTotal` must equal the hold's `total` shown to the user. Never pass card data or codes here. While fewer than 3 purchases have succeeded, `userApproved: true` is required (only after the user tapped ✅). Never retried. May return status 'needs_cvv', 'needs_3ds' or 'needs_email_code' with a challengeId — the hub collects the secret via secure input and calls cines_submit_code. `dryRun: true` simulates without paying.",
      inputSchema: {
        holdId: z.string(),
        expectedTotal: z.number().positive().describe("MXN; must equal the hold's `total` shown to the user"),
        method: z.enum(["card", "paypal"]).optional().describe("Default card = card saved in the user's Cinépolis/DEUNA wallet (CVV via secure input); paypal needs the user at the server Mac"),
        cardLast4: z.string().regex(/^\d{4}$/).optional().describe("Only if the user has several saved cards and named one (last four digits)"),
        userApproved: z.boolean().optional(),
        dryRun: z.boolean().optional(),
      },
      annotations: ACTS,
    },
    async ({ expectedTotal, ...rest }) => {
      try {
        return await runInteractive(() =>
          purchase({ ...rest, expectedTotalMxn: expectedTotal }, {
            holds: ctx.holds,
            ledger: ctx.ledger,
            driver: ctx.driver,
            dryRunDriver: ctx.dryRunDriver,
            cap: capMxn(),
            arm: ctx.arm,
            pin: ctx.pin,
            ask: (kind, prompt, imageUrl) => ctx.broker.ask(kind, prompt, { imageUrl }),
          }).then((r) => {
            const imageUrl = publishShot(ctx, r.screenshotPath);
            const { screenshotPath: _p, ...pub } = r;
            const e = ctx.ledger.recent(20).find((x) => x.purchaseId === r.purchaseId);
            if (e && imageUrl) {
              e.imageUrl = imageUrl;
              ctx.ledger.update(e);
            }
            return { ...pub, imageUrl, next: imageUrl ? "Envía imageUrl (confirmación) al usuario." : undefined };
          }),
          waitMs,
          "cines_purchase",
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cines_submit_code",
    {
      title: "Deliver a secret the user typed (hub only)",
      description:
        "HUB ONLY — must not be exposed to the language model. Delivers the user's secure-input reply (6-digit e-mail code, 3DS/OTP code, CVV or arming PIN) for a challengeId from a needs_* result, and continues the paused operation, returning its next result (held / paid / another needs_* / error). The value is never logged or returned.",
      inputSchema: { challengeId: z.string(), code: z.string().min(1).max(32) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ challengeId, code }) => {
      try {
        const job = jobs.get(challengeId);
        ctx.broker.submit(challengeId, code);
        if (!job) return ok({ status: "accepted" });
        jobs.delete(challengeId);
        return await runInteractive(() => job);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
