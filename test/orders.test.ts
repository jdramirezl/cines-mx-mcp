import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiKeyProvider } from "../src/cinepolis/apikey.js";
import { GraphQLClient } from "../src/cinepolis/client.js";
import { HoldService } from "../src/cinepolis/orders.js";
import { CinepolisProvider } from "../src/cinepolis/provider.js";
import { SeatsSchema } from "../src/cinepolis/schemas.js";
import { mapSeatLayout } from "../src/cinepolis/seats.js";
import type { Cinema, Showtime } from "../src/domain.js";
import type { HttpRequest, Transport } from "../src/http/transport.js";
import { buildOrderData, chooseTicket, newOrderSessionId } from "../src/order/orderData.js";
import { DryRunDriver, NotYetEnabledDriver, PurchaseLedger, purchase, capMxn } from "../src/order/purchase.js";
import { DEFAULT_PROFILE } from "../src/profile.js";
import { runUntilInput, SecureInputBroker } from "../src/secure.js";
import { startServer } from "../src/server.js";
import type { Services } from "../src/services.js";
import { decodeQuotedPrintable, extractCode, isCodeEmail } from "../src/session/mailbox.js";
import { jwtExpiry, parseAuth0Cache, SessionManager, type SessionBrowser } from "../src/session/session.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const fx = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/cinepolis/${name}.json`, import.meta.url), "utf8"));
const tmp = () => mkdtempSync(join(tmpdir(), "cines-orders-"));
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = (expSec: number) => [b64({ alg: "none" }), b64({ exp: expSec }), "sig"].join(".");
const NOW = Date.parse("2026-10-19T18:00:00-06:00");

const cinema: Cinema = { chain: "cinepolis", id: "cinepolis-parque-toreo-cdmx", vistaId: "570", name: "Parque Toreo", type: "TRADICIONAL", isVip: false, cityId: "cdmx", timezone: "America/Mexico_City", businessType: "NEON", requireContiguousSeating: false };
const showtime: Showtime = { chain: "cinepolis", id: "570-102599", sessionId: "102599", cinemaId: cinema.id, cinemaVistaId: "570", movieId: "street-fighter", movieVistaId: "HO1", date: "2026-10-20", time: "19:00", startsAt: "2026-10-20T19:00:00-06:00", language: "SUB", languageLabel: "SUBTITULADA", format: "2D", screen: "6", availability: "free", isAllocatedSeating: true, alerts: [] };
const layout = () => mapSeatLayout(SeatsSchema.parse(fx("seats").data));
const seat = (l: string) => layout().rows.flatMap((r) => r.seats).find((s) => s.label === l)!;

/** Fake Cinépolis API: fixtures for reads + an in-memory order system. */
function fakeCinepolis() {
  const calls: { path: string; op: string; vars: any; auth?: string }[] = [];
  const state = { held: new Set<string>(), cancelled: [] as string[], usidN: 0, orderTotal: 19800 };
  const t: Transport = async (r: HttpRequest) => {
    const body = JSON.parse(r.body ?? "{}");
    const op = body.operationName as string;
    const v = body.variables ?? {};
    const path = new URL(r.url).pathname;
    calls.push({ path, op, vars: v, auth: r.headers?.Authorization });
    const member = ["UserSessionId", "Order"].includes(op);
    if (member && !r.headers?.Authorization) return { status: 401, headers: {}, text: "{}" };
    let data: unknown;
    switch (op) {
      case "Cinemas": data = fx("cinemas"); break;
      case "Billboard": data = v.cinemaId ? fx("billboardByCinema").data : fx("billboardByMovie").data; break;
      case "Movies": data = v.id ? fx("movie").data : fx("movies").data; break;
      case "Seats": data = fx("seats").data; break;
      case "Tickets": data = v.userSessionId ? fx("memberTickets").data : fx("tickets").data; break;
      case "UserSessionId": data = { user_session_id: `usid${String(++state.usidN).padStart(28, "0")}` }; break;
      case "Order": {
        const od = v.orderData;
        state.held.add(od.tickets.orderId);
        const n = od.tickets.seats.length;
        data = { order: { order: { cinemaVistaId: "570", orderUserId: "x", tickets: { orderId: od.tickets.orderId }, total: n * 9900 * (state.orderTotal / 19800), charges: n * 700, subtotal: n * 9200 } } };
        break;
      }
      case "CancelOrder": {
        const id = v.input.order_session_id;
        const found = state.held.delete(id);
        state.cancelled.push(id);
        data = { CancelOrder: { cancelOrderResult: { extended_result_code: 0, order_not_found: !found, result: 0, error_description: null } } };
        break;
      }
      case "ExtendOrder": data = { ExtendOrder: { extendOrderResult: { status: state.held.has(v.user_session_id) ? "true" : "false" } } }; break;
      default: return { status: 200, headers: {}, text: JSON.stringify({ errors: [{ message: `unknown op ${op}` }] }) };
    }
    return { status: 200, headers: {}, text: JSON.stringify({ data }) };
  };
  const client = new GraphQLClient({ transport: t, apiKey: new ApiKeyProvider(t, "K"), minIntervalMs: 0 });
  return { client, calls, state };
}

describe("order data", () => {
  it("rebuilds the captured Order mutation input exactly (except per-run ids)", () => {
    const captured = fx("order").variables.orderData;
    const built = buildOrderData({
      orderSessionId: captured.orderSessionId,
      userSessionId: captured.tickets.orderId,
      countryId: "MX",
      cinema,
      showtime: { ...showtime, sessionId: captured.tickets.schedule.sessionId },
      movie: { name: "Street Fighter", image: captured.tickets.movie.image },
      layout: layout(),
      seats: [seat("C6"), seat("C7")],
      tickets: fx("tickets").data.tickets[0].tickets,
      selectedTicketId: "2223",
    });
    expect(built).toEqual(captured);
  });
  it("generates site-style orderSessionIds", () => {
    expect(newOrderSessionId(1_760_900_000_000)).toMatch(/^[0-9a-f-]{36}-1760900000000$/);
    expect(newOrderSessionId().length).toBe(50);
  });
  it("chooses Admision General by default, an explicit type on request", () => {
    const types = [
      { id: "1", code: "a", description: "Que Oferton 2026", priceMxn: 45, bookingFeeMxn: 7, areaCategoryCode: "1", isPackage: false },
      { id: "2", code: "b", description: "Admision General", priceMxn: 92, bookingFeeMxn: 7, areaCategoryCode: "1", isPackage: false },
    ];
    expect(chooseTicket(types, undefined, "Admision General")?.id).toBe("2");
    expect(chooseTicket(types, "que oferton", "Admision General")?.id).toBe("1");
    expect(chooseTicket(types, "VIP", "Admision General")).toBeUndefined();
  });
});

describe("session", () => {
  const entries = (expMs: number, refresh = true) => ({
    "@@auth0spajs@@::client123::https://cnpls-redesign::openid profile email offline_access": JSON.stringify({ body: { access_token: "AT", refresh_token: refresh ? "RT" : undefined, expires_in: 86400 }, expiresAt: Math.floor(expMs / 1000) }),
    "@@auth0spajs@@::client123::@@user@@": JSON.stringify({ id_token: "x" }),
  });
  it("reads the access token from auth0-spa-js localStorage and never the refresh token", () => {
    const t = parseAuth0Cache(entries(NOW + 3_600_000), NOW)!;
    expect(t).toMatchObject({ accessToken: "AT", hasRefreshToken: true, audience: "https://cnpls-redesign" });
    expect(JSON.stringify(t)).not.toContain("RT");
    expect(parseAuth0Cache({ foo: "bar" })).toBeUndefined();
    expect(jwtExpiry(fakeJwt(1000))).toBe(1_000_000);
  });
  it("keepalive -> login with mailbox code -> user code, single-flight", async () => {
    let refreshes = 0;
    let logins = 0;
    let codeSeen = "";
    const browser: SessionBrowser = {
      refresh: async () => (refreshes++, {}),
      loginWithEmailCode: async (_email, getCode) => {
        logins++;
        codeSeen = await getCode(NOW);
        return entries(NOW + 86_400_000);
      },
    };
    const s = new SessionManager({ browser, mailbox: { waitForCode: async () => "123456" }, loginEmail: "user@example.com", now: () => NOW, log: () => undefined });
    const [a, b] = await Promise.all([s.getAccessToken(), s.getAccessToken()]);
    expect([a, b]).toEqual(["AT", "AT"]);
    expect([refreshes, logins, codeSeen]).toEqual([1, 1, "123456"]);
    expect(s.status()).toMatchObject({ state: "valid", hasRefreshToken: true, mailbox: true });
  });
  it("falls back to asking the user when the mailbox has nothing", async () => {
    const broker = new SecureInputBroker(() => NOW);
    const browser: SessionBrowser = { refresh: async () => ({}), loginWithEmailCode: async (_e, getCode) => (await getCode(NOW), entries(NOW + 86_400_000)) };
    const s = new SessionManager({ browser, broker, mailbox: { waitForCode: async () => undefined }, loginEmail: "user@example.com", now: () => NOW, log: () => undefined });
    const r = await runUntilInput(broker, () => s.getAccessToken(), { waitMs: 2000 });
    expect(r.done).toBe(false);
    if (r.done || !r.request) throw new Error("expected input request");
    expect(r.request.kind).toBe("email_code");
    expect(() => broker.submit(r.request!.requestId, "12")).toThrow(/Formato/);
    broker.submit(r.request.requestId, "654 321");
    await expect(r.job).resolves.toBe("AT");
  });
  it("refuses to log in when not allowed or not configured", async () => {
    await expect(new SessionManager({ log: () => undefined }).getAccessToken()).rejects.toMatchObject({ code: "CINES_SESSION_EXPIRED" });
    const s = new SessionManager({ browser: { refresh: async () => ({}), loginWithEmailCode: async () => ({}) }, loginEmail: "u@example.com", log: () => undefined });
    await expect(s.getAccessToken({ allowLogin: false })).rejects.toMatchObject({ code: "CINES_SESSION_EXPIRED" });
  });
  it("uses a static dev token with its JWT expiry", async () => {
    const tok = fakeJwt(Math.floor(NOW / 1000) + 7200);
    const s = new SessionManager({ staticToken: tok, now: () => NOW, log: () => undefined });
    await expect(s.getAccessToken()).resolves.toBe(tok);
  });
});

describe("mailbox code extraction", () => {
  it("finds the 6-digit code near 'código' and ignores other numbers", () => {
    expect(extractCode("Verifica tu cuenta", "Hola, tu código de verificación es: 482913. Vigencia 10 min. Folio 1234567")).toBe("482913");
    expect(extractCode("Tu código Cinépolis", "<td style='x'>&nbsp;915203&nbsp;</td>")).toBe("915203");
    expect(extractCode("Promo", "Llama al 5521226060 o usa 123456 o 654321")).toBeUndefined();
  });
  it("skips promos from the same sender", () => {
    expect(isCodeEmail("¡2x1 en dulcería este martes!", "Usa el cupón 482913 en taquilla")).toBe(false);
    expect(extractCode("¡2x1 en dulcería este martes!", "Usa el cupón 482913 en taquilla")).toBeUndefined();
    expect(isCodeEmail("Club Cinépolis", "Ingresa este código de verificación: 112233")).toBe(true);
    expect(isCodeEmail("Verifica tu cuenta", "")).toBe(true);
  });
  it("decodes quoted-printable and base64 parts", () => {
    expect(decodeQuotedPrintable("c=C3=B3digo: 11=\r\n2233")).toBe("código: 112233");
    const raw = `Content-Type: text/html\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from("tu código es 777888").toString("base64")}\r\n`;
    expect(extractCode("", decodeQuotedPrintable(raw))).toBe("777888");
  });
});

describe("HoldService", () => {
  const req = (seats: string[], extra: Partial<Parameters<HoldService["hold"]>[0]> = {}) => ({
    cinema, showtime, movie: { name: "Street Fighter" }, layout: layout(), seats: seats.map(seat), defaultTicketType: "Admision General", accessToken: "AT", ...extra,
  });
  it("holds with the site's calls, auth only where needed, and releases via /v1/carts", async () => {
    const api = fakeCinepolis();
    const dir = tmp();
    const hs = new HoldService({ client: api.client, stateFile: join(dir, "holds.json"), log: () => undefined });
    const h = await hs.hold(req(["D5", "D6"]));
    expect(h).toMatchObject({ status: "held", seats: ["D5", "D6"], ticketType: "Admision General", unitMxn: 92, totalMxn: 198, chargesMxn: 14 });
    expect(api.calls.map((c) => c.op)).toEqual(["UserSessionId", "Tickets", "Order"]);
    expect(api.calls[0]).toMatchObject({ path: "/v1/members/graphql", vars: { cinemaId: "570" }, auth: "AT" });
    expect(api.calls[1]!.auth).toBeUndefined();
    const order = api.calls[2]!.vars.orderData;
    expect(order.tickets.orderId).toBe(h.priv.orderId);
    expect(order.tickets.seats.map((s: any) => s.number)).toEqual(["D5", "D6"]);
    expect(statSync(join(dir, "holds.json")).mode & 0o777).toBe(0o600);
    await expect(hs.hold(req(["E5", "E6"]))).rejects.toThrow(/Ya hay asientos/);
    const r = await hs.release();
    expect(r?.status).toBe("released");
    const cancel = api.calls.at(-1)!;
    expect(cancel).toMatchObject({ path: "/v1/carts/graphql", op: "CancelOrder", vars: { input: { country_id: "MX", order_session_id: h.priv.orderId } } });
    expect(hs.active()).toBeUndefined();
  });
  it("refuses holds above the cap before ordering, and releases if the real total exceeds it", async () => {
    const api = fakeCinepolis();
    const hs = new HoldService({ client: api.client, stateFile: join(tmp(), "h.json"), capMxn: 150, log: () => undefined });
    await expect(hs.hold(req(["D5", "D6"]))).rejects.toMatchObject({ code: "CINES_LIMIT_EXCEEDED" });
    expect(api.calls.some((c) => c.op === "Order")).toBe(false);
    api.state.orderTotal = 19800 * 2; // site charges more than our estimate
    const hs2 = new HoldService({ client: api.client, stateFile: join(tmp(), "h.json"), capMxn: 200, log: () => undefined });
    await expect(hs2.hold(req(["D5", "D6"]))).rejects.toMatchObject({ code: "CINES_LIMIT_EXCEEDED" });
    expect(api.state.cancelled).toHaveLength(1);
  });
  it("auto-releases on timeout and releases orphans after a restart", async () => {
    const api = fakeCinepolis();
    const file = join(tmp(), "h.json");
    const hs = new HoldService({ client: api.client, stateFile: file, ttlMs: 30, log: () => undefined });
    await hs.hold(req(["D5"]));
    await new Promise((r) => setTimeout(r, 80));
    expect(api.state.cancelled).toHaveLength(1);
    const hs2 = new HoldService({ client: api.client, stateFile: file, ttlMs: 60_000, log: () => undefined });
    await hs2.hold(req(["E5"]));
    const hs3 = new HoldService({ client: api.client, stateFile: file, log: () => undefined });
    expect(await hs3.releaseOrphans()).toBe(1);
    expect(api.state.cancelled).toHaveLength(2);
  });
  it("extends a live hold", async () => {
    const api = fakeCinepolis();
    let now = NOW;
    const hs = new HoldService({ client: api.client, stateFile: join(tmp(), "h.json"), now: () => now, log: () => undefined });
    const h = await hs.hold(req(["D5"]));
    const before = Date.parse(h.expiresAt);
    now += 60_000;
    const e = await hs.extend(h.holdId, 300_000);
    expect(Date.parse(e.expiresAt)).toBe(before + 300_000);
    await hs.release();
  });
});

describe("purchase guardrails", () => {
  async function setup(opts: { successes?: number } = {}) {
    const api = fakeCinepolis();
    const dir = tmp();
    const holds = new HoldService({ client: api.client, stateFile: join(dir, "h.json"), log: () => undefined });
    const ledger = new PurchaseLedger(join(dir, "p.json"));
    for (let i = 0; i < (opts.successes ?? 0); i++) ledger.add({ holdId: `old${i}`, at: "x", totalMxn: 1, method: "paypal", status: "paid" });
    const h = await holds.hold({ cinema, showtime, movie: { name: "SF" }, layout: layout(), seats: [seat("D5"), seat("D6")], defaultTicketType: "Admision General", accessToken: "AT" });
    const broker = new SecureInputBroker();
    const deps = (driver = new DryRunDriver()) => ({ holds, ledger, driver, dryRunDriver: new DryRunDriver(), ask: (k: any, p: string) => broker.ask(k, p), log: () => undefined });
    return { h, holds, ledger, broker, deps, api };
  }
  it("dry-run pays nothing and leaves the hold usable", async () => {
    const { h, deps, holds } = await setup();
    const r = await purchase({ holdId: h.holdId, expectedTotalMxn: 198, dryRun: true }, deps());
    expect(r).toMatchObject({ status: "paid", dryRun: true, bookingNumber: expect.stringMatching(/^DRYRUN-/) });
    expect(holds.get(h.holdId)?.status).toBe("held");
  });
  it("requires the user's ✅ for the first 3 real purchases", async () => {
    const { h, deps } = await setup({ successes: 2 });
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 198 }, deps())).rejects.toThrow(/aprobación/);
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 198, userApproved: true }, deps())).resolves.toMatchObject({ status: "paid" });
  });
  it("after 3 successes no ✅ is needed, but totals must match and payments never retry", async () => {
    const { h, deps } = await setup({ successes: 3 });
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 184 }, deps())).rejects.toThrow(/no coincide/);
    const failing = new DryRunDriver({ fail: "Banco rechazó" });
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 198 }, deps(failing as any))).rejects.toMatchObject({ code: "CINES_PAYMENT_FAILED", message: expect.stringMatching(/No se reintentará/) });
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 198 }, deps())).rejects.toThrow(/ya no están apartados|nunca reintento/);
  });
  it("enforces the hard cap regardless of configuration", async () => {
    const { h, deps } = await setup({ successes: 5 });
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 198 }, { ...deps(), cap: 100 })).rejects.toMatchObject({ code: "CINES_LIMIT_EXCEEDED" });
    expect(capMxn({ CINES_PURCHASE_CAP_MXN: "5000" })).toBe(1000);
    expect(capMxn({ CINES_PURCHASE_CAP_MXN: "500" })).toBe(500);
  });
  it("the not-yet-enabled driver refuses before recording anything", async () => {
    const { h, deps, ledger } = await setup({ successes: 5 });
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 198 }, deps(new NotYetEnabledDriver() as any))).rejects.toThrow(/aún no está habilitado/);
    expect(ledger.find(h.holdId)).toBeUndefined();
  });
  it("relays a secure input (3DS) to the driver without exposing it", async () => {
    const { h, deps, broker } = await setup({ successes: 5 });
    const d = deps(new DryRunDriver({ askFor: "otp_3ds" }) as any);
    const r = await runUntilInput(broker, () => purchase({ holdId: h.holdId, expectedTotalMxn: 198 }, d), { waitMs: 2000 });
    if (r.done || !r.request) throw new Error("expected needs_input");
    expect(r.request.kind).toBe("otp_3ds");
    broker.submit(r.request.requestId, "998877");
    await expect(r.job).resolves.toMatchObject({ status: "paid" });
  });
});

describe("MCP order tools", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let client: Client;
  const api = fakeCinepolis();
  const broker = new SecureInputBroker();
  const dir = tmp();
  // Session needs a login code from the user on first use.
  const session = new SessionManager({
    browser: { refresh: async () => ({}), loginWithEmailCode: async (_e, getCode) => (await getCode(Date.now()), { "@@auth0spajs@@::c::a::s": JSON.stringify({ body: { access_token: "AT", refresh_token: "RT" }, expiresAt: Math.floor(Date.now() / 1000) + 86400 }) }) },
    broker,
    loginEmail: "user@example.com",
    log: () => undefined,
  });
  const services: Services = {
    holds: new HoldService({ client: api.client, stateFile: join(dir, "h.json"), log: () => undefined }),
    session,
    broker,
    ledger: new PurchaseLedger(join(dir, "p.json")),
    driver: new NotYetEnabledDriver(),
    dryRunDriver: new DryRunDriver({ askFor: "cvv" }),
    stop: () => undefined,
  };

  beforeAll(async () => {
    const provider = new CinepolisProvider({ client: api.client });
    srv = await startServer({ port: 0, provider, profile: DEFAULT_PROFILE, services, now: () => new Date(NOW) });
    client = new Client({ name: "t", version: "1" });
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

  it("marks hold and purchase as destructive, release as safe", async () => {
    const { tools } = await client.listTools();
    const a = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(a.cines_hold_seats?.destructiveHint).toBe(true);
    expect(a.cines_purchase?.destructiveHint).toBe(true);
    expect(a.cines_release_hold?.destructiveHint).toBe(false);
    expect(a.cines_secure_input).toBeDefined();
  });

  it("hold -> login code via secure input -> held; purchase dry-run -> CVV via secure input -> paid; release", async () => {
    const bad = await call("cines_hold_seats", { showtimeId: "570-102599", seats: "Z99" });
    expect(bad.value.error.code).toBe("CINES_BAD_REQUEST");
    const first = await call("cines_hold_seats", { showtimeId: "570-102599", seats: "D5,D6" });
    expect(first.value).toMatchObject({ status: "needs_input", kind: "email_code", secure: true });
    const held = await call("cines_secure_input", { requestId: first.value.requestId, value: "123456" });
    expect(held.value).toMatchObject({ status: "held", seats: ["D5", "D6"], totalMxn: 198, purchaseApprovalRequired: true });
    expect(JSON.stringify(held.value)).not.toMatch(/orderId|orderSessionId|usid/);
    const status = await call("cines_hold_status");
    expect(status.value.hold.holdId).toBe(held.value.holdId);
    const real = await call("cines_purchase", { holdId: held.value.holdId, expectedTotalMxn: 198, userApproved: true });
    expect(real.value.error.code).toBe("CINES_PAYMENT_FAILED");
    const p1 = await call("cines_purchase", { holdId: held.value.holdId, expectedTotalMxn: 198, dryRun: true });
    expect(p1.value).toMatchObject({ status: "needs_input", kind: "cvv" });
    const wrong = await call("cines_secure_input", { requestId: p1.value.requestId, value: "12" });
    expect(wrong.value.error.code).toBe("CINES_BAD_REQUEST");
    const p2 = await call("cines_secure_input", { requestId: p1.value.requestId, value: "123" });
    expect(p2.value).toMatchObject({ status: "paid", dryRun: true });
    const rel = await call("cines_release_hold");
    expect(rel.value.status).toBe("released");
  }, 20_000);
});
