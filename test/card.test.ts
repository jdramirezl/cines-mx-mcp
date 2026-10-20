/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync, readFileSync } from "node:fs";
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
import type { HttpRequest, Transport } from "../src/http/transport.js";
import { PaymentArm } from "../src/order/arm.js";
import { CardCheckDeferred, CardDriver, cardTypeFor, chooseCard, fingerprintFallback, listSavedCards, type CardSession, type CardUi, type SavedCard, type VaultCard } from "../src/order/card.js";
import { DryRunDriver, MethodRouter, PurchaseLedger, purchase } from "../src/order/purchase.js";
import { registerOrderTools } from "../src/orderTools.js";
import { DEFAULT_PROFILE } from "../src/profile.js";
import { SecureInputBroker } from "../src/secure.js";
import { SessionManager } from "../src/session/session.js";

const fx = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/cinepolis/${name}.json`, import.meta.url), "utf8"));
const tmp = () => mkdtempSync(join(tmpdir(), "cines-card-"));
const NOW = Date.parse("2026-10-20T21:00:00Z");
const CVV = "739";
const BUYER = { email: "buyer@example.com", firstName: "Ana", lastName: "Prueba" };

type Charge = "ok" | "declined" | "network" | "5xx" | "empty";

function fakeApi(o: { charge?: Charge; dispatcher?: () => unknown; methods?: any } = {}) {
  const calls: { op: string; vars: any; auth?: string; raw: string }[] = [];
  const state = { cancelled: [] as string[], extended: 0, charges: 0 };
  const t: Transport = async (r: HttpRequest) => {
    const body = JSON.parse(r.body ?? "{}");
    const op = body.operationName as string;
    const v = body.variables ?? {};
    calls.push({ op, vars: v, auth: r.headers?.Authorization, raw: r.body ?? "" });
    let data: unknown;
    switch (op) {
      case "payment_methods":
        if (!r.headers?.Authorization) return { status: 401, headers: {}, text: "{}" };
        data = o.methods ?? fx("paymentMethods").data;
        break;
      case "UserSessionDeuna":
        data = { userSessionDeuna: { user_token: "deuna-user-token" } };
        break;
      case "handlerComplete":
        state.charges++;
        if (o.charge === "network") throw new Error("socket hang up");
        if (o.charge === "5xx") return { status: 502, headers: {}, text: "{}" };
        if (o.charge === "declined") return { status: 200, headers: {}, text: JSON.stringify({ data: { handlerComplete: null }, errors: [{ message: "Transacción declinada por el banco" }] }) };
        if (o.charge === "empty") return { status: 200, headers: {}, text: JSON.stringify({ data: { handlerComplete: { bookingInfo: null } } }) };
        data = fx("handlerComplete").response.data;
        break;
      case "OrderDispatcher":
        data = { orderDispatcher: o.dispatcher ? o.dispatcher() : null };
        break;
      case "CancelOrder":
        state.cancelled.push(v.input.order_session_id);
        data = { CancelOrder: { cancelOrderResult: { extended_result_code: 0, order_not_found: false, result: 0, error_description: null } } };
        break;
      case "ExtendOrder":
        state.extended++;
        data = { ExtendOrder: { extendOrderResult: { status: "true" } } };
        break;
      default:
        return { status: 200, headers: {}, text: JSON.stringify({ errors: [{ message: `unknown op ${op}` }] }) };
    }
    return { status: 200, headers: {}, text: JSON.stringify({ data }) };
  };
  const client = new GraphQLClient({ transport: t, apiKey: new ApiKeyProvider(t, "K"), minIntervalMs: 0 });
  return { client, calls, state };
}

function heldOrder(holds: HoldService, status: Hold["status"] = "held"): Hold {
  const h: Hold = {
    holdId: `hold_${Math.random().toString(16).slice(2, 10)}`,
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 9 * 60_000).toISOString(),
    status,
    cinemaId: "cinepolis-parque-toreo-cdmx",
    cinemaName: "Parque Toreo",
    showtimeId: "570-102633",
    date: "2026-10-23",
    time: "18:30",
    language: "SUB",
    format: "2D",
    seats: ["C7"],
    ticketType: "Admision General",
    unitMxn: 92,
    chargesMxn: 7,
    subtotalMxn: 92,
    totalMxn: 99,
    priv: { orderId: "ORDER_ID_VISTA", orderSessionId: "60f72293-c5aa-4bbb-8ccc-000000000000-1792530000000", cinemaVistaId: "570", sessionId: "102633" },
  };
  holds.update(h);
  return h;
}

interface UiOpts {
  cards?: SavedCard[];
  all?: SavedCard[];
  fraud?: string | undefined;
  vault?: VaultCard | Error;
}

function fakeUi(o: UiOpts = {}) {
  const seen = { vaultUrl: "", cvv: [] as string[], selected: [] as string[], listed: 0, shots: [] as string[] };
  const ui: CardUi = {
    runCard: async (opts, fn) => {
      seen.vaultUrl = opts.vaultUrl;
      const s: CardSession = {
        cards: async (all) => {
          if (all) seen.listed++;
          return all ? (o.all ?? o.cards ?? []) : (o.cards ?? [{ lastFour: "4242", isDefault: true, selected: true }]);
        },
        selectCard: async (l) => void seen.selected.push(l),
        fraudId: async () => ("fraud" in o ? o.fraud : "FRAUD_ID"),
        submitCvv: async (cvv) => {
          seen.cvv.push(cvv);
          if (o.vault instanceof Error) throw o.vault;
          return o.vault ?? { id: "CARD_ID", firstSix: "424242", lastFour: "4242", company: "MASTERCARD", cardType: "credit_card" };
        },
        screenshot: async (n) => (seen.shots.push(n), `/private/${n}.png`),
      };
      return fn(s);
    },
  };
  return { ui, seen };
}

function rig(api: ReturnType<typeof fakeApi>, uiOpts: UiOpts = {}, defaultLastFour?: string) {
  const dir = tmp();
  const holds = new HoldService({ client: api.client, stateFile: join(dir, "holds.json"), log: () => undefined, now: () => NOW });
  const { ui, seen } = fakeUi(uiOpts);
  const driver = new CardDriver({ client: api.client, holds, accessToken: async () => "AT", buyer: async () => BUYER, ui, defaultLastFour, now: () => NOW, sleep: async () => undefined });
  const ledger = new PurchaseLedger(join(dir, "purchases.json"));
  const arm = new PaymentArm(join(dir, "arm.json"), () => NOW);
  arm.arm(30);
  const logs: string[] = [];
  const asked: { kind: string; prompt: string }[] = [];
  const deps = {
    holds,
    ledger,
    driver: new MethodRouter({ card: driver }),
    dryRunDriver: new DryRunDriver(),
    arm,
    now: () => NOW,
    log: (m: string) => void logs.push(m),
    ask: async (kind: any, prompt: string) => {
      asked.push({ kind, prompt });
      return CVV;
    },
  };
  return { dir, holds, ledger, arm, deps, seen, logs, asked };
}

/** Nothing derived from the CVV may appear anywhere but the vault. */
function assertNoCvv(r: ReturnType<typeof rig>, api: ReturnType<typeof fakeApi>, ...extra: unknown[]) {
  const blobs = [JSON.stringify(api.calls), r.logs.join("\n"), readFileSync(join(r.dir, "purchases.json"), "utf8"), readFileSync(join(r.dir, "holds.json"), "utf8"), JSON.stringify(extra)];
  for (const b of blobs) expect(b).not.toContain(CVV);
}

describe("card helpers", () => {
  it("rebuilds the site's fallback fingerprint", () => {
    expect(fingerprintFallback("570", "60f72293-c5aa-4bbb", 1, new Date("2026-10-20T21:00:00Z"))).toBe("570_60f72293c5_2610202100_1");
  });
  it("maps card brands like the site", () => {
    expect([cardTypeFor("MASTERCARD"), cardTypeFor("mastercard"), cardTypeFor("VISA"), cardTypeFor("AMERICAN_EXPRESS"), cardTypeFor("carnet")]).toEqual(["master", "master", "visa", "amex", "carnet"]);
  });
  it("chooses the explicit, else selected/default card, and refuses ambiguity or expiry", () => {
    const cards: SavedCard[] = [{ lastFour: "1111" }, { lastFour: "2222", isDefault: true }, { lastFour: "3333", expired: true }];
    expect(chooseCard(cards).lastFour).toBe("2222");
    expect(chooseCard(cards, "1111").lastFour).toBe("1111");
    expect(() => chooseCard(cards, "9999")).toThrow(/terminada en 9999.*\*1111, \*2222, \*3333/);
    expect(() => chooseCard(cards, "3333")).toThrow(/vencida/);
    expect(() => chooseCard([{ lastFour: "1111" }, { lastFour: "4444" }])).toThrow(/varias tarjetas/);
    expect(() => chooseCard([])).toThrow(/no tienes tarjetas/);
  });
});

describe("CardDriver", () => {
  it("pays with the saved card: one handlerComplete shaped exactly like the captured one", async () => {
    const api = fakeApi();
    const r = rig(api);
    const h = heldOrder(r.holds);
    const res = await purchase({ holdId: h.holdId, expectedTotalMxn: 99, userApproved: true }, r.deps);
    expect(res).toMatchObject({ status: "paid", bookingNumber: "100001", transactionNumber: "200002", total: 99, currency: "MXN" });
    expect(api.state.charges).toBe(1);
    const charge = api.calls.find((c) => c.op === "handlerComplete")!;
    const want = structuredClone(fx("handlerComplete").variables);
    want.input.order_session_id = h.priv.orderSessionId;
    want.input.payment.payment_info.payment_fingerprint_fallback = "570_60f72293c5_2610202100_1";
    expect(charge.vars).toEqual(want);
    expect(charge.auth).toBe("AT");
    // Vault URL built like the site's (saved-card flow, user token).
    const u = new URL(r.seen.vaultUrl);
    expect(u.origin + u.pathname).toBe("https://cinepolis.elements.deuna.com/vault");
    expect(Object.fromEntries(u.searchParams)).toEqual({ publicApiKey: "pk_fixture_public", firstName: "Ana", lastName: "Prueba", email: "buyer@example.com", showSavedCardsFlow: "true", userToken: "deuna-user-token" });
    // CVV asked through secure input, typed into the vault only.
    expect(r.asked).toEqual([{ kind: "cvv", prompt: expect.stringMatching(/\*4242.*\$99/) }]);
    expect(r.seen.cvv).toEqual([CVV]);
    expect(api.state.extended).toBeGreaterThanOrEqual(1);
    expect(api.state.cancelled).toEqual([]);
    expect(r.holds.get(h.holdId)?.status).toBe("purchased");
    expect(r.arm.status().armed).toBe(false);
    assertNoCvv(r, api, res);
  });

  it("is the default method", async () => {
    const api = fakeApi();
    const r = rig(api);
    const h = heldOrder(r.holds);
    await purchase({ holdId: h.holdId, expectedTotalMxn: 99, userApproved: true }, r.deps);
    expect(r.ledger.recent(1)[0]).toMatchObject({ method: "card", status: "paid" });
  });

  it("a decline Cinépolis answers releases the seats; nothing is retried", async () => {
    const api = fakeApi({ charge: "declined" });
    const r = rig(api);
    const h = heldOrder(r.holds);
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 99, userApproved: true }, r.deps)).rejects.toMatchObject({
      code: "CINES_PAYMENT_FAILED",
      message: expect.stringMatching(/rechazó el pago con la tarjeta \*4242 \(Transacción declinada por el banco\).*No se cobró nada.*No se reintentará/),
    });
    expect(api.state.charges).toBe(1);
    expect(api.state.cancelled).toEqual([h.priv.orderId]);
    expect(r.ledger.recent(1)[0]?.status).toBe("failed");
    assertNoCvv(r, api);
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 99, userApproved: true }, r.deps)).rejects.toThrow();
    expect(api.state.charges).toBe(1);
  });

  it("no reliable answer = unknown: seats kept, not retried, user told to check e-mail", async () => {
    for (const charge of ["network", "5xx", "empty"] as const) {
      const api = fakeApi({ charge });
      const r = rig(api);
      const h = heldOrder(r.holds);
      await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 99, userApproved: true }, r.deps)).rejects.toMatchObject({ code: "CINES_UNAVAILABLE", message: expect.stringMatching(/incierto.*revisa tu correo/) });
      expect(api.state.charges).toBe(1);
      expect(api.state.cancelled).toEqual([]);
      expect(r.ledger.recent(1)[0]?.status).toBe("unknown");
    }
  });

  it("after an error answer, OrderDispatcher decides: booking = paid, a status = unknown", async () => {
    const paid = fakeApi({ charge: "declined", dispatcher: () => ({ status: "SUCCESS", booking_id: "B", transaction: { booking_number: "777", trans_number: "8" } }) });
    const a = rig(paid);
    const h1 = heldOrder(a.holds);
    await expect(purchase({ holdId: h1.holdId, expectedTotalMxn: 99, userApproved: true }, a.deps)).resolves.toMatchObject({ status: "paid", bookingNumber: "777" });
    const pending = fakeApi({ charge: "declined", dispatcher: () => ({ status: "PENDING", booking_id: null, transaction: null }) });
    const b = rig(pending);
    const h2 = heldOrder(b.holds);
    await expect(purchase({ holdId: h2.holdId, expectedTotalMxn: 99, userApproved: true }, b.deps)).rejects.toMatchObject({ code: "CINES_UNAVAILABLE", message: expect.stringMatching(/PENDING/) });
    expect(pending.state.cancelled).toEqual([]);
  });

  it("a network failure that still booked is reported paid", async () => {
    let n = 0;
    const api = fakeApi({ charge: "network", dispatcher: () => (++n >= 2 ? { status: "SUCCESS", booking_id: "B", transaction: { booking_number: "555", trans_number: "6" } } : null) });
    const r = rig(api);
    const h = heldOrder(r.holds);
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 99, userApproved: true }, r.deps)).resolves.toMatchObject({ status: "paid", bookingNumber: "555" });
  });

  it("anything failing before the charge releases and never calls handlerComplete", async () => {
    const cases: [string, Parameters<typeof fakeApi>[0], UiOpts, RegExp][] = [
      ["vault error", {}, { vault: Object.assign(new Error("x"), {}) }, /paso de la tarjeta/],
      ["no card method", { methods: { payment_methods: fx("paymentMethods").data.payment_methods.filter((m: any) => m.key !== "bank_card_deuna") } }, {}, /no ofrece pago con tarjeta/],
      ["3DS only", { methods: { payment_methods: [{ ...fx("paymentMethods").data.payment_methods[0], key: "bank_card_3ds" }] } }, {}, /^Tu banco pidió una verificación extra \(3-D Secure\).*no cobré nada y liberé los asientos\. Intenta con PayPal o desde la app de Cinépolis\. No se reintentará/],
      ["no saved card", {}, { cards: [], all: [] }, /no tienes tarjetas/],
    ];
    for (const [name, apiOpts, uiOpts, re] of cases) {
      const api = fakeApi(apiOpts);
      const r = rig(api, uiOpts);
      const h = heldOrder(r.holds);
      await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 99, userApproved: true }, r.deps), name).rejects.toMatchObject({ code: "CINES_PAYMENT_FAILED", message: expect.stringMatching(re) });
      expect(api.state.charges, name).toBe(0);
      expect(api.state.cancelled, name).toEqual([h.priv.orderId]);
    }
  });

  it("uses the named card, switching in the vault; refuses an unknown one without charging", async () => {
    const all: SavedCard[] = [{ lastFour: "4242", isDefault: true, selected: true }, { lastFour: "1881" }];
    const api = fakeApi();
    const r = rig(api, { cards: [all[0]!], all });
    const h = heldOrder(r.holds);
    await purchase({ holdId: h.holdId, expectedTotalMxn: 99, userApproved: true, cardLast4: "1881" }, r.deps);
    expect(r.seen.listed).toBe(1);
    expect(r.seen.selected).toEqual(["1881"]);
    const api2 = fakeApi();
    const r2 = rig(api2, { cards: [all[0]!], all }, "9999");
    const h2 = heldOrder(r2.holds);
    await expect(purchase({ holdId: h2.holdId, expectedTotalMxn: 99, userApproved: true }, r2.deps)).rejects.toThrow(/terminada en 9999/);
    expect(api2.state.charges).toBe(0);
    await expect(purchase({ holdId: h2.holdId, expectedTotalMxn: 99, cardLast4: "12" }, r2.deps)).rejects.toThrow(/4 dígitos/);
  });

  it("sends an empty fingerprint when DEUNA's SDK gives no fraud id (fallback still set)", async () => {
    const api = fakeApi();
    const r = rig(api, { fraud: undefined });
    const h = heldOrder(r.holds);
    await purchase({ holdId: h.holdId, expectedTotalMxn: 99, userApproved: true }, r.deps);
    const pi = api.calls.find((c) => c.op === "handlerComplete")!.vars.input.payment.payment_info;
    expect(pi.payment_fingerprint).toBe("");
    expect(pi.payment_fingerprint_fallback).toMatch(/^570_60f72293c5_\d{10}_1$/);
    expect(r.logs.join("\n")).toMatch(/fraud id unavailable/);
  });

  it("the router refuses a method with no driver before consuming the arm", async () => {
    const api = fakeApi();
    const r = rig(api);
    const h = heldOrder(r.holds);
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 99, userApproved: true, method: "paypal" }, r.deps)).rejects.toThrow(/no está disponible/);
    expect(r.arm.status().armed).toBe(true);
  });

  it("lists saved cards read-only for preflight", async () => {
    const api = fakeApi();
    const { ui, seen } = fakeUi({ all: [{ lastFour: "4242", isDefault: true }, { lastFour: "0005", expired: true }] });
    const cards = await listSavedCards({ client: api.client, accessToken: async () => "AT", buyer: async () => BUYER, ui }, "fresh-session");
    expect(cards.map((c) => c.lastFour)).toEqual(["4242", "0005"]);
    expect(seen.cvv).toEqual([]);
    expect(api.calls.map((c) => c.op)).toEqual(["payment_methods", "UserSessionDeuna"]);
  });
});

describe("card purchase over MCP", () => {
  it("returns needs_cvv, takes the CVV only via cines_submit_code, and never echoes it", async () => {
    const api = fakeApi();
    const r = rig(api);
    const h = heldOrder(r.holds);
    const broker = new SecureInputBroker();
    const server = new McpServer({ name: "t", version: "1" });
    const card = new CardDriver({ client: api.client, holds: r.holds, accessToken: async () => "AT", buyer: async () => BUYER, ui: fakeUi().ui, now: () => NOW, sleep: async () => undefined });
    registerOrderTools(server, {
      provider: new CinepolisProvider({ client: api.client }),
      profile: DEFAULT_PROFILE,
      now: () => new Date(NOW),
      holds: r.holds,
      session: new SessionManager({ staticToken: "x", log: () => undefined }),
      broker,
      ledger: r.ledger,
      driver: new MethodRouter({ card }),
      arm: r.arm,
      waitMs: 2000,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: "t", version: "1" });
    await c.connect(ct);
    const call = async (name: string, args: any) => ((await c.callTool({ name, arguments: args })) as any).content[0].text as string;
    // Hold expiry is checked against the real clock in the tool path.
    const fresh = r.holds.get(h.holdId)!;
    fresh.expiresAt = new Date(Date.now() + 9 * 60_000).toISOString();
    r.holds.update(fresh);
    const first = JSON.parse(await call("cines_purchase", { holdId: h.holdId, expectedTotal: 99, userApproved: true }));
    expect(first).toMatchObject({ status: "needs_cvv", secure: true, kind: "cvv", challengeId: expect.stringMatching(/^sec_/) });
    const bad = JSON.parse(await call("cines_submit_code", { challengeId: first.challengeId, code: "12" }));
    expect(bad.error.code).toBe("CINES_BAD_REQUEST");
    const done = await call("cines_submit_code", { challengeId: first.challengeId, code: CVV });
    expect(JSON.parse(done)).toMatchObject({ status: "paid", bookingNumber: "100001" });
    expect(done).not.toContain(CVV);
    const status = await call("cines_hold_status", {});
    expect(status).not.toContain(CVV);
    assertNoCvv(r, api, first, done, status);
    await c.close();
  });
});

describe("card preflight", () => {
  it("defers (does not fail) when payment_methods rejects an order session without a hold", async () => {
    const t: Transport = async (r: HttpRequest) => {
      const op = JSON.parse(r.body ?? "{}").operationName;
      if (op === "payment_methods") return { status: 200, headers: {}, text: JSON.stringify({ data: { payment_methods: null }, errors: [{ message: "404: Tu compra no pudo ser completada. Por favor, vuelve a intentarlo en unos minutos." }] }) };
      return { status: 200, headers: {}, text: JSON.stringify({ errors: [{ message: `unexpected ${op}` }] }) };
    };
    const client = new GraphQLClient({ transport: t, apiKey: new ApiKeyProvider(t, "K"), minIntervalMs: 0 });
    const { ui, seen } = fakeUi();
    await expect(listSavedCards({ client, accessToken: async () => "AT", buyer: async () => BUYER, ui }, "fresh")).rejects.toBeInstanceOf(CardCheckDeferred);
    expect(seen.vaultUrl).toBe("");
    const { runPreflight } = await import("../src/preflight.js");
    const checks = await runPreflight("bad-id", 1, {
      provider: new CinepolisProvider({ client }), client, profile: DEFAULT_PROFILE,
      holds: new HoldService({ client, stateFile: join(tmp(), "h.json"), log: () => undefined }),
      ledger: new PurchaseLedger(join(tmp(), "p.json")), arm: new PaymentArm(join(tmp(), "a.json")),
      session: new SessionManager({ staticToken: "x", log: () => undefined }),
      savedCards: () => listSavedCards({ client, accessToken: async () => "AT", buyer: async () => BUYER, ui }, "fresh"),
      env: {}, chromePath: tmp(),
    });
    expect(checks.find((c) => c.name === "card")).toMatchObject({ ok: true, info: true, detail: expect.stringMatching(/^se verifica al apartar/) });
  });

  it("the purchase path asks payment_methods for the hold's own order session", async () => {
    const api = fakeApi();
    const r = rig(api);
    const h = heldOrder(r.holds);
    await purchase({ holdId: h.holdId, expectedTotalMxn: 99, userApproved: true }, r.deps);
    expect(api.calls.find((c) => c.op === "payment_methods")!.vars).toEqual({ orderSessionId: h.priv.orderSessionId, countryId: "MX" });
  });
});
