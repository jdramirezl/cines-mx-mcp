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
import { PaymentArm } from "../src/order/arm.js";
import { PaypalDriver, type PaymentPage, type PaymentUi } from "../src/order/paypal.js";
import { DryRunDriver, NotYetEnabledDriver, PurchaseLedger, purchase, capMxn } from "../src/order/purchase.js";
import { runPreflight } from "../src/preflight.js";
import { DEFAULT_PROFILE } from "../src/profile.js";
import { runUntilInput, SecureInputBroker } from "../src/secure.js";
import { startServer } from "../src/server.js";
import { buildMailbox, type Services } from "../src/services.js";
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
  const state = { held: new Set<string>(), cancelled: [] as string[], extended: 0, usidN: 0, orderTotal: 19800, checkouts: 0, dispatcher: (() => null) as () => unknown };
  const t: Transport = async (r: HttpRequest) => {
    const body = JSON.parse(r.body ?? "{}");
    const op = body.operationName as string;
    const v = body.variables ?? {};
    const path = new URL(r.url).pathname;
    calls.push({ path, op, vars: v, auth: r.headers?.Authorization });
    const member = ["UserSessionId", "Order", "paypalWalletCheckout", "Profile"].includes(op);
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
      case "ExtendOrder": state.extended++; data = { ExtendOrder: { extendOrderResult: { status: state.held.has(v.user_session_id) ? "true" : "false" } } }; break;
      case "paypalWalletCheckout": state.checkouts++; data = { paypalWalletCheckout: { orderToken: { order_token: `tok_${v.order_session_id.slice(0, 8)}` } } }; break;
      case "OrderDispatcher": data = { orderDispatcher: state.dispatcher() }; break;
      case "Profile": data = { member: { levelName: "Fan" } }; break;
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
  it("buildMailbox follows CINES_IMAP_USER and the session reports it", () => {
    expect(buildMailbox({})).toBeUndefined();
    const mb = buildMailbox({ CINES_IMAP_USER: "bot@example.com" });
    expect(mb).toBeDefined();
    expect(new SessionManager({ mailbox: mb, log: () => undefined }).status().mailbox).toBe(true);
    expect(new SessionManager({ mailbox: buildMailbox({}), log: () => undefined }).status().mailbox).toBe(false);
  });
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
    expect(api.calls.map((c) => c.op)).toEqual(["UserSessionId", "Tickets", "Tickets", "Order"]);
    expect(api.calls[0]).toMatchObject({ path: "/v1/members/graphql", vars: { cinemaId: "570" }, auth: "AT" });
    expect(api.calls[1]).toMatchObject({ auth: "AT", vars: { userSessionId: expect.stringMatching(/^usid/) } });
    expect(api.calls[2]!.auth).toBeUndefined();
    expect(api.calls[2]!.vars.userSessionId).toBeUndefined();
    const order = api.calls[3]!.vars.orderData;
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
  it("VIP: uses that showtime's own area, ticket and cinema data (Miyana 673, live-observed shape)", async () => {
    const api = fakeCinepolis();
    const vipTickets = { tickets: [{ areaCategoryCode: "0000000001", tickets: [{ id: "2223", ticketTypeCode: "0001", description: "Admision General", ticketDescription: null, priceInCents: 19700, bookingFee: 700, taxInCents: 0, displaySequence: 0, quantityAvailablePerOrder: 10, type: "general", isPackageTicket: false }] }] };
    const realCall = api.client.call.bind(api.client);
    (api.client as any).call = (op: any, vars: any, o: any) => (op.operationName === "Tickets" && !vars.userSessionId ? Promise.resolve(vipTickets) : realCall(op, vars, o));
    const vipCinema = { ...cinema, id: "cinepolis-vip-miyana-polanco-cdmx", vistaId: "673", name: "Miyana Polanco", type: "VIP", isVip: true, businessType: "VIP" };
    const vipLayout = { ...layout(), areaName: "VIP" };
    const hs = new HoldService({ client: api.client, stateFile: join(tmp(), "h.json"), log: () => undefined });
    const h = await hs.hold({ cinema: vipCinema, showtime: { ...showtime, cinemaVistaId: "673", sessionId: "56651" }, movie: { name: "Clayface" }, layout: vipLayout, seats: [seat("D5")], defaultTicketType: "Admision General", accessToken: "AT" });
    expect(h.ticketType).toBe("Admision General");
    const od = api.calls.find((c) => c.op === "Order")!.vars.orderData;
    expect(od.cinema).toMatchObject({ vistaId: "673", type: "VIP", businessType: "VIP" });
    expect(od.tickets.schedule.sessionId).toBe("56651");
    expect(od.tickets.seats[0]).toMatchObject({ description: "VIP", ticketsOptions: [expect.objectContaining({ id: "2223", ticketTypeCode: "0001", price: 19700, selected: true })] });
    await hs.release();
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
    const arm = new PaymentArm(join(dir, "arm.json"));
    arm.arm(30);
    const deps = (driver = new DryRunDriver()) => ({ holds, ledger, driver, dryRunDriver: new DryRunDriver(), arm, ask: (k: any, p: string) => broker.ask(k, p), log: () => undefined });
    return { h, holds, ledger, broker, deps, api, arm };
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
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 198 }, deps())).rejects.toThrow(/ya no están apartados|nunca reintento|no está armado/);
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
    expect(a.cines_submit_code).toBeDefined();
    expect(a.cines_secure_input).toBeUndefined();
  });

  it("hold -> login code via secure input -> held; purchase dry-run -> CVV via secure input -> paid; release", async () => {
    const bad = await call("cines_hold_seats", { showtimeId: "570-102599", seats: ["Z99"] });
    expect(bad.value.error.code).toBe("CINES_BAD_REQUEST");
    const mism = await call("cines_hold_seats", { showtimeId: "570-102599", seats: ["D5", "D6"], tickets: 3 });
    expect(mism.value.error.message).toMatch(/3 boleto/);
    const first = await call("cines_hold_seats", { showtimeId: "570-102599", seats: ["D5", "D6"], tickets: 2 });
    expect(first.value).toMatchObject({ status: "needs_email_code", kind: "email_code", secure: true, challengeId: expect.stringMatching(/^sec_/) });
    const held = await call("cines_submit_code", { challengeId: first.value.challengeId, code: "123456" });
    expect(held.value).toMatchObject({ status: "held", seats: ["D5", "D6"], total: 198, currency: "MXN", cinema: "Parque Toreo", startsAt: "2026-10-20T19:00:00-06:00", purchaseApprovalRequired: true });
    expect(JSON.stringify(held.value)).not.toMatch(/orderId|orderSessionId|usid/);
    const status = await call("cines_hold_status");
    expect(status.value.hold.holdId).toBe(held.value.holdId);
    const real = await call("cines_purchase", { holdId: held.value.holdId, expectedTotal: 198, userApproved: true });
    expect(real.value.error.code).toBe("CINES_PAYMENT_FAILED");
    const p1 = await call("cines_purchase", { holdId: held.value.holdId, expectedTotal: 198, dryRun: true });
    expect(p1.value).toMatchObject({ status: "needs_cvv", kind: "cvv" });
    const wrong = await call("cines_submit_code", { challengeId: p1.value.challengeId, code: "12" });
    expect(wrong.value.error.code).toBe("CINES_BAD_REQUEST");
    const p2 = await call("cines_submit_code", { challengeId: p1.value.challengeId, code: "123" });
    expect(p2.value).toMatchObject({ status: "paid", dryRun: true, total: 198, currency: "MXN", purchaseId: expect.stringMatching(/^pur_/) });
    expect(JSON.stringify(p2.value)).not.toContain("123\"");
    const rel = await call("cines_release_hold");
    expect(rel.value.status).toBe("released");
  }, 20_000);
});

describe("payment arm", () => {
  it("arms for one attempt, expires, and refuses when not armed", () => {
    let now = NOW;
    const a = new PaymentArm(join(tmp(), "arm.json"), () => now);
    expect(a.status().armed).toBe(false);
    expect(() => a.consume()).toThrow(/no está armado/);
    expect(a.arm(500).minutesLeft).toBe(60); // capped
    a.consume();
    expect(() => a.consume()).toThrow(/no está armado/);
    a.arm(30);
    now += 31 * 60_000;
    expect(a.status().armed).toBe(false);
    a.arm(30);
    a.disarm();
    expect(a.status().armed).toBe(false);
  });
});

describe("purchase arming", () => {
  async function held() {
    const api = fakeCinepolis();
    const dir = tmp();
    const holds = new HoldService({ client: api.client, stateFile: join(dir, "h.json"), log: () => undefined });
    const ledger = new PurchaseLedger(join(dir, "p.json"));
    for (let i = 0; i < 5; i++) ledger.add({ holdId: `o${i}`, at: "x", totalMxn: 1, method: "paypal", status: "paid" });
    const h = await holds.hold({ cinema, showtime, movie: { name: "SF" }, layout: layout(), seats: [seat("D5")], defaultTicketType: "Admision General", accessToken: "AT" });
    const arm = new PaymentArm(join(dir, "arm.json"));
    return { api, holds, ledger, h, arm, base: { holds, ledger, ask: async () => "", log: () => undefined } };
  }
  it("refuses real payment when not armed, before recording anything", async () => {
    const { h, ledger, base } = await held();
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 99 }, { ...base, driver: new DryRunDriver(), arm: new PaymentArm(join(tmp(), "a.json")) })).rejects.toThrow(/no está armado/);
    expect(ledger.find(h.holdId)).toBeUndefined();
  });
  it("dryRun never consumes the arm; a real attempt consumes it even when it fails", async () => {
    const { h, base, arm } = await held();
    arm.arm(30);
    await purchase({ holdId: h.holdId, expectedTotalMxn: 99, dryRun: true }, { ...base, driver: new DryRunDriver(), arm });
    expect(arm.status().armed).toBe(true);
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 99 }, { ...base, driver: new DryRunDriver({ fail: "x" }), arm })).rejects.toThrow();
    expect(arm.status().armed).toBe(false);
  });
  it("an unsupported method is refused before the arm is consumed", async () => {
    const { h, base, arm, api, holds } = await held();
    arm.arm(30);
    const d = new PaypalDriver({ client: api.client, holds, accessToken: async () => "AT", buyer: async () => ({ email: "u@example.com", firstName: "A", lastName: "B" }), ui: { run: async () => ({}) as any } });
    await expect(purchase({ holdId: h.holdId, expectedTotalMxn: 99, method: "card" }, { ...base, driver: d, arm })).rejects.toThrow(/aún no está disponible/);
    expect(arm.status().armed).toBe(true);
  });
});

describe("PaypalDriver", () => {
  function rig(opts: { dispatcherAfter?: number; dispatcher?: () => unknown; close?: number; text?: string; checkoutFails?: boolean } = {}) {
    const api = fakeCinepolis();
    const holds = new HoldService({ client: api.client, stateFile: join(tmp(), "h.json"), log: () => undefined });
    let t = NOW;
    let polls = 0;
    api.state.dispatcher = opts.dispatcher ?? (() => (++polls >= (opts.dispatcherAfter ?? Infinity) ? { status: "COMPLETED", booking_id: "B1", transaction: { booking_number: "BK123", trans_number: "TR9" } } : null));
    const shots: string[] = [];
    const ui: PaymentUi = {
      run: async (url, fn) => {
        expect(url).toMatch(/^https:\/\/pay\.deuna\.io\/now\/tok_/);
        let ticks = 0;
        const page: PaymentPage = { isClosed: () => opts.close !== undefined && ++ticks > opts.close, text: async () => opts.text ?? "Redirigiendo a PayPal", screenshot: async (n) => (shots.push(n), `/private/${n}.png`) };
        return fn(page);
      },
    };
    const driver = new PaypalDriver({
      client: api.client,
      holds,
      accessToken: async () => {
        if (opts.checkoutFails) throw new Error("no session");
        return "AT";
      },
      buyer: async () => ({ email: "u@example.com", firstName: "A", lastName: "B" }),
      ui,
      waitMs: 15 * 60_000,
      pollMs: 5000,
      extendEveryMs: 4 * 60_000,
      now: () => t,
      sleep: async (ms) => void (t += ms),
    });
    return { api, holds, driver, shots };
  }
  const ctx = async (holds: HoldService) => {
    const h = await holds.hold({ cinema, showtime, movie: { name: "SF" }, layout: layout(), seats: [seat("D5")], defaultTicketType: "Admision General", accessToken: "AT" });
    h.status = "purchasing";
    holds.update(h);
    return { hold: h, method: "paypal" as const, ask: async () => "", log: () => undefined };
  };

  it("waits for the user, keeps the order alive, and captures the booking + screenshot", async () => {
    const { driver, holds, api, shots } = rig({ dispatcherAfter: 100 }); // ~8 min of polling
    const r = await driver.pay(await ctx(holds));
    expect(r).toEqual({ bookingNumber: "BK123", transactionNumber: "TR9", screenshotPath: "/private/confirmation.png" });
    expect(api.state.extended).toBeGreaterThanOrEqual(1);
    expect(api.state.cancelled).toHaveLength(0);
    expect(shots).toEqual(["confirmation"]);
    const co = api.calls.find((c) => c.op === "paypalWalletCheckout")!;
    expect(co).toMatchObject({ path: "/v1/purchase/graphql", auth: "AT", vars: { country_id: "MX", format: "2D", isPartial: false, email: "u@example.com" } });
  });
  it("times out after waiting, releases the hold and does not retry", async () => {
    const { driver, holds, api } = rig();
    const c = await ctx(holds);
    await expect(driver.pay(c)).rejects.toMatchObject({ code: "CINES_PAYMENT_FAILED", message: expect.stringMatching(/15 min.*No se cobró nada/) });
    expect(api.state.cancelled).toEqual([c.hold.priv.orderId]);
    expect(api.state.checkouts).toBe(1);
    expect(holds.get(c.hold.holdId)?.status).toBe("released");
  });
  it("closing the window releases; an in-between state does NOT release", async () => {
    const a = rig({ close: 2 });
    await expect(a.driver.pay(await ctx(a.holds))).rejects.toThrow(/Se cerró la ventana/);
    expect(a.api.state.cancelled).toHaveLength(1);
    const b = rig({ dispatcher: () => ({ status: "PENDING", booking_id: null, transaction: null }), close: 1 });
    await expect(b.driver.pay(await ctx(b.holds))).rejects.toMatchObject({ code: "CINES_UNAVAILABLE", message: expect.stringMatching(/PENDING/) });
    expect(b.api.state.cancelled).toHaveLength(0);
  });
  it("stops on an unrecognized page and when checkout cannot start", async () => {
    const a = rig({ text: "Algo salió mal" });
    await expect(a.driver.pay(await ctx(a.holds))).rejects.toThrow(/no se reconoció/);
    expect(a.shots).toContain("unexpected");
    const b = rig({ checkoutFails: true });
    await expect(b.driver.pay(await ctx(b.holds))).rejects.toThrow(/No pude iniciar el pago/);
    expect(b.api.state.cancelled).toHaveLength(1);
  });
});

describe("preflight", () => {
  it("runs read-only checks and flags a dangling hold", async () => {
    const api = fakeCinepolis();
    const dir = tmp();
    const holds = new HoldService({ client: api.client, stateFile: join(dir, "h.json"), log: () => undefined });
    const deps = {
      provider: new CinepolisProvider({ client: api.client }),
      client: api.client,
      profile: DEFAULT_PROFILE,
      holds,
      ledger: new PurchaseLedger(join(dir, "p.json")),
      arm: new PaymentArm(join(dir, "a.json")),
      session: new SessionManager({ staticToken: fakeJwt(Math.floor(Date.now() / 1000) + 86400), log: () => undefined }),
      paypalLoggedIn: async () => true,
      env: { CINES_LOGIN_EMAIL: "u@example.com", CINES_BUYER_NAME: "A B", CINES_IMAP_USER: "b@example.com" },
      chromePath: tmp(),
    };
    const future = showtime; // fixture session 102599 is in the fixture billboard
    const checks = await runPreflight(future.id, 2, deps);
    const by = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(by["release-path"]?.ok).toBe(true);
    expect(by["booking-check"]?.ok).toBe(true);
    expect(by.session?.ok).toBe(true);
    expect(by.paypal?.ok).toBe(true);
    expect(by.state?.ok).toBe(true);
    expect(by.arm?.detail).toMatch(/desarmado/);
    expect(api.calls.some((c) => ["Order", "paypalWalletCheckout", "UserSessionId"].includes(c.op))).toBe(false);
    await holds.hold({ cinema, showtime, movie: { name: "SF" }, layout: layout(), seats: [seat("D5")], defaultTicketType: "Admision General", accessToken: "AT" });
    const again = await runPreflight(future.id, 2, deps);
    expect(again.find((c) => c.name === "state")?.ok).toBe(false);
    await holds.release();
  });
});
