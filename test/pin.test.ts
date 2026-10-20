/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { ApiKeyProvider } from "../src/cinepolis/apikey.js";
import { GraphQLClient } from "../src/cinepolis/client.js";
import { HoldService, type Hold } from "../src/cinepolis/orders.js";
import { CinepolisProvider } from "../src/cinepolis/provider.js";
import type { Transport } from "../src/http/transport.js";
import { PaymentArm } from "../src/order/arm.js";
import { PinArm } from "../src/order/pin.js";
import { DryRunDriver, PurchaseLedger, purchase, type PaymentDriver } from "../src/order/purchase.js";
import { registerOrderTools } from "../src/orderTools.js";
import { DEFAULT_PROFILE } from "../src/profile.js";
import { SecureInputBroker } from "../src/secure.js";
import { SessionManager } from "../src/session/session.js";

const PIN = "583914";
const NOW = Date.parse("2026-10-20T21:00:00Z");
const tmp = () => mkdtempSync(join(tmpdir(), "cines-pin-"));

const t: Transport = async () => ({ status: 200, headers: {}, text: JSON.stringify({ data: { CancelOrder: { cancelOrderResult: { order_not_found: false } } } }) });
const client = new GraphQLClient({ transport: t, apiKey: new ApiKeyProvider(t, "K"), minIntervalMs: 0 });

function rig(opts: { pin?: boolean; ask?: (kind: string) => string } = {}) {
  const dir = tmp();
  const clock = { now: NOW };
  const now = () => clock.now;
  const holds = new HoldService({ client, stateFile: join(dir, "holds.json"), log: () => undefined, now });
  const ledger = new PurchaseLedger(join(dir, "p.json"));
  const arm = new PaymentArm(join(dir, "arm.json"), now);
  const pin = new PinArm(join(dir, "pin.json"), now);
  if (opts.pin !== false) pin.set(PIN);
  const asked: string[] = [];
  const logs: string[] = [];
  const paid: string[] = [];
  const driver: PaymentDriver = {
    name: "fake",
    supports: () => true,
    pay: async (ctx) => {
      paid.push(ctx.hold.holdId);
      await ctx.ask("cvv", "CVV");
      return { bookingNumber: "BK1" };
    },
  };
  const hold = (id = "hold_a", total = 99): Hold => {
    const h: any = { holdId: id, createdAt: "", expiresAt: new Date(NOW + 9 * 60_000).toISOString(), status: "held", cinemaId: "c", cinemaName: "C", showtimeId: "570-1", date: "", time: "", language: "SUB", format: "2D", seats: ["C7"], ticketType: "AG", unitMxn: 92, chargesMxn: 7, subtotalMxn: 92, totalMxn: total, priv: { orderId: "o", orderSessionId: "s", cinemaVistaId: "570", sessionId: "1" } };
    holds.update(h);
    return h;
  };
  const deps = {
    holds, ledger, arm, pin, driver, dryRunDriver: new DryRunDriver(), now,
    log: (m: string) => void logs.push(m),
    ask: async (kind: any) => {
      asked.push(kind);
      return opts.ask ? opts.ask(kind) : kind === "arm_pin" ? PIN : "123";
    },
  };
  return { dir, clock, holds, ledger, arm, pin, asked, logs, paid, hold, deps };
}

describe("PinArm", () => {
  it("stores only a salted scrypt hash in a 0600 file", () => {
    const dir = tmp();
    const p = new PinArm(join(dir, "pin.json"), () => NOW);
    p.set(PIN);
    const raw = readFileSync(join(dir, "pin.json"), "utf8");
    expect(raw).not.toContain(PIN);
    expect(JSON.parse(raw)).toMatchObject({ v: 1, salt: expect.stringMatching(/^[0-9a-f]{32}$/), hash: expect.stringMatching(/^[0-9a-f]{64}$/), failures: 0, disabled: false });
    expect(statSync(join(dir, "pin.json")).mode & 0o777).toBe(0o600);
    const q = new PinArm(join(tmp(), "pin.json"));
    q.set(PIN);
    expect(JSON.parse(readFileSync((q as any).file, "utf8")).hash).not.toBe(JSON.parse(raw).hash); // fresh salt
  });
  it("refuses weak or malformed PINs", () => {
    const p = new PinArm(join(tmp(), "pin.json"));
    for (const bad of ["12345", "123456789", "abcdef", "111111", "123456", "876543"]) expect(() => p.set(bad), bad).toThrow();
  });
  it("rate-limits to one attempt per 30 s and disables after 3 wrong in a row", () => {
    let now = NOW;
    const p = new PinArm(join(tmp(), "pin.json"), () => now);
    p.set(PIN);
    expect(p.verify("000001")).toEqual({ ok: false, disabled: false, attemptsLeft: 2 });
    expect(() => p.verify(PIN)).toThrow(/espera 30 s/);
    expect(p.status().waitSeconds).toBe(30);
    now += 30_000;
    expect(p.verify(PIN)).toEqual({ ok: true }); // success resets the streak
    for (let i = 0; i < 3; i++) {
      now += 30_000;
      p.verify("000002");
    }
    expect(p.status()).toMatchObject({ disabled: true, failures: 3 });
    now += 30_000;
    expect(p.verify(PIN)).toEqual({ ok: false, disabled: true, attemptsLeft: 0 });
    expect(() => p.usable()).toThrow(/desactivado.*set-arm-pin/);
    p.set("490271");
    expect(p.status()).toMatchObject({ configured: true, disabled: false, failures: 0 });
  });
});

describe("purchase with PIN arming", () => {
  it("asks the PIN (before the CVV), arms only this hold, consumes it, and never records the PIN", async () => {
    const r = rig();
    const h = r.hold();
    const res = await purchase({ holdId: h.holdId, expectedTotalMxn: 99, userApproved: true }, r.deps);
    expect(res).toMatchObject({ status: "paid", bookingNumber: "BK1" });
    expect(r.asked).toEqual(["arm_pin", "cvv"]);
    expect(r.arm.status().armed).toBe(false);
    expect(r.logs).toContain("arm pin attempt: ok");
    for (const f of ["p.json", "holds.json", "pin.json"]) expect(readFileSync(join(r.dir, f), "utf8")).not.toContain(PIN);
    expect(r.logs.join("\n")).not.toContain(PIN);
  });

  it("a Mac arm is used as before, without asking the PIN", async () => {
    const r = rig();
    r.arm.arm(30);
    const h = r.hold();
    await purchase({ holdId: h.holdId, expectedTotalMxn: 99, userApproved: true }, r.deps);
    expect(r.asked).toEqual(["cvv"]);
  });

  it("a wrong PIN fails before anything is recorded or charged; the hold stays", async () => {
    const r = rig({ ask: (k) => (k === "arm_pin" ? "000001" : "123") });
    const h = r.hold();
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 99, userApproved: true }, r.deps)).rejects.toMatchObject({ code: "CINES_PAYMENT_FAILED", message: expect.stringMatching(/PIN incorrecto \(te quedan 2 intentos; espera 30 s\)\. No se cobró nada/) });
    expect(r.paid).toEqual([]);
    expect(r.ledger.recent(5)).toEqual([]);
    expect(r.holds.get(h.holdId)?.status).toBe("held");
    expect(r.arm.status().armed).toBe(false);
    expect(r.logs).toContain("arm pin attempt: wrong");
    // Within 30 s: refused before asking again.
    r.asked.length = 0;
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 99, userApproved: true }, r.deps)).rejects.toThrow(/Espera \d+ s/);
    expect(r.asked).toEqual([]);
  });

  it("the third wrong PIN disables PIN arming; then it is refused without asking", async () => {
    const r = rig({ ask: (k) => (k === "arm_pin" ? "000001" : "123") });
    const h = r.hold();
    for (let i = 0; i < 3; i++) {
      r.clock.now += 30_000;
      await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 99, userApproved: true }, r.deps)).rejects.toThrow(i === 2 ? /Desactivé el armado por PIN/ : /PIN incorrecto/);
    }
    r.asked.length = 0;
    r.clock.now += 30_000;
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 99, userApproved: true }, r.deps)).rejects.toThrow(/desactivado tras 3 PIN incorrectos/);
    expect(r.asked).toEqual([]);
  });

  it("no PIN configured and not armed: the old refusal, no prompt", async () => {
    const r = rig({ pin: false });
    const h = r.hold();
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 99, userApproved: true }, r.deps)).rejects.toThrow(/no está armado/);
    expect(r.asked).toEqual([]);
  });

  it("guards run before the PIN prompt (total mismatch, approval, dryRun never asks)", async () => {
    const r = rig();
    const h = r.hold();
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 98, userApproved: true }, r.deps)).rejects.toThrow(/no coincide/);
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 99 }, r.deps)).rejects.toThrow(/aprobación/);
    await purchase({ holdId: h.holdId, expectedTotalMxn: 99, dryRun: true }, r.deps);
    expect(r.asked).toEqual([]);
  });

  it("a PIN arm is bound to its hold and total", () => {
    const r = rig();
    r.arm.arm(10, { holdId: "hold_a", totalMxn: 99 });
    expect(r.arm.status()).toMatchObject({ armed: true, via: "pin", holdId: "hold_a", minutesLeft: 10 });
    expect(() => r.arm.consume({ holdId: "hold_b", totalMxn: 99 })).toThrow(/otro apartado/);
    expect(r.arm.status().armed).toBe(false); // discarded, not reusable
    r.arm.arm(10, { holdId: "hold_a", totalMxn: 99 });
    expect(() => r.arm.consume({ holdId: "hold_a", totalMxn: 100 })).toThrow(/otro apartado o total/);
    r.arm.arm(10, { holdId: "hold_a", totalMxn: 99 });
    r.arm.consume({ holdId: "hold_a", totalMxn: 99 });
  });
});

describe("PIN arming over MCP", () => {
  it("needs_arm_pin → cines_submit_code → needs_cvv → cines_submit_code → paid", async () => {
    const r = rig();
    const h = r.hold();
    const fresh = r.holds.get(h.holdId)!;
    fresh.expiresAt = new Date(Date.now() + 9 * 60_000).toISOString(); // tool path checks the real clock
    r.holds.update(fresh);
    r.clock.now = Date.now();
    const server = new McpServer({ name: "t", version: "1" });
    registerOrderTools(server, {
      provider: new CinepolisProvider({ client }), profile: DEFAULT_PROFILE, now: () => new Date(),
      holds: r.holds, session: new SessionManager({ staticToken: "x", log: () => undefined }),
      broker: new SecureInputBroker(), ledger: r.ledger, driver: r.deps.driver, arm: r.arm, pin: r.pin, waitMs: 2000,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: "t", version: "1" });
    await c.connect(ct);
    const call = async (name: string, args: any) => ((await c.callTool({ name, arguments: args })) as any).content[0].text as string;
    const first = JSON.parse(await call("cines_purchase", { holdId: h.holdId, expectedTotal: 99, userApproved: true }));
    expect(first).toMatchObject({ status: "needs_arm_pin", secure: true, kind: "arm_pin", challengeId: expect.stringMatching(/^sec_/), prompt: expect.stringMatching(/PIN.*\$99/) });
    const pending = JSON.parse(await call("cines_hold_status", {}));
    expect(pending.pendingInput).toEqual([expect.objectContaining({ requestId: first.challengeId, kind: "arm_pin" })]);
    expect(pending.pinArming).toMatchObject({ configured: true, disabled: false });
    const second = await call("cines_submit_code", { challengeId: first.challengeId, code: PIN });
    expect(second).not.toContain(PIN);
    expect(JSON.parse(second)).toMatchObject({ status: "needs_cvv", kind: "cvv" });
    const done = JSON.parse(await call("cines_submit_code", { challengeId: JSON.parse(second).challengeId, code: "123" }));
    expect(done).toMatchObject({ status: "paid" });
    expect(await call("cines_hold_status", {})).not.toContain(PIN);
    await c.close();
  });
});
