import { describe, expect, it } from "vitest";
import { ApiKeyProvider, chunkUrls, findKey, SCHEDULES_MF } from "../src/cinepolis/apikey.js";
import { GraphQLClient } from "../src/cinepolis/client.js";
import { CINEMAS } from "../src/cinepolis/queries.js";
import { CinesError } from "../src/errors.js";
import { classify } from "../src/http/classify.js";
import { Pacer } from "../src/http/pacer.js";
import { orderHeaders, type HttpRequest, type HttpResponse, type Transport } from "../src/http/transport.js";

const CF_BLOCK_HTML =
  '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body><h1>Sorry, you have been blocked</h1></body></html>';
const CF_CHALLENGE_HTML = "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cf-chl-</body></html>";
const res = (status: number, text: string, headers: Record<string, string> = {}): HttpResponse => ({ status, text, headers });
const FAKE_KEY = "F".repeat(24) + "a".repeat(24);

describe("classify", () => {
  it("recognizes Cloudflare block and challenge pages", () => {
    expect(classify(res(403, CF_BLOCK_HTML, { server: "cloudflare" })).kind).toBe("cloudflare-block");
    expect(classify(res(403, CF_CHALLENGE_HTML)).kind).toBe("cloudflare-challenge");
  });
  it("separates auth, rate limit, outage, contract change and success", () => {
    expect(classify(res(401, '{"message":"no"}')).kind).toBe("unauthorized");
    expect(classify(res(429, "{}")).kind).toBe("rate-limited");
    expect(classify(res(502, "{}")).kind).toBe("server-error");
    expect(classify(res(200, "<html>maintenance</html>")).kind).toBe("not-json");
    expect(classify(res(200, '{"data":{}}')).kind).toBe("ok");
  });
});

describe("orderHeaders", () => {
  it("puts Host first and fills browser defaults", () => {
    const h = orderHeaders(new URL("https://api-g.cinepolis.com/x"), { "x-apikey": "k", "User-Agent": "UA" });
    const keys = Object.keys(h);
    expect(keys[0]).toBe("Host");
    expect(h.Host).toBe("api-g.cinepolis.com");
    expect(keys[1]).toBe("User-Agent");
    expect(h["User-Agent"]).toBe("UA");
    expect(keys).toContain("Accept");
    expect(keys.at(-1)).toBe("x-apikey");
  });
});

describe("Pacer", () => {
  it("spaces requests and de-duplicates identical in-flight work", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const pacer = new Pacer(300, () => t, async (ms) => {
      sleeps.push(ms);
      t += ms;
    });
    let calls = 0;
    const task = async () => ++calls;
    const [a, b] = await Promise.all([pacer.run("k", task), pacer.run("k", task)]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    await pacer.run("other", task);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([300]);
  });
});

describe("api key discovery", () => {
  const entry =
    'r.u=function(e){return"static/chunks/"+(({499:"eb1f83f1",830:"__federation_expose_Schedules"})[e]||e)+"."+({25:"9a0a157fda92f4b7",165:"03bd31c95b195f7f",830:"aaaaaaaaaaaaaaaa"})[e]+".js"}';
  it("lists chunk URLs from the webpack map", () => {
    const urls = chunkUrls(entry);
    expect(urls).toContain("https://schedules-mf.cinepolis.com/_next/static/chunks/165.03bd31c95b195f7f.js");
    expect(urls).toContain("https://schedules-mf.cinepolis.com/_next/static/chunks/__federation_expose_Schedules.aaaaaaaaaaaaaaaa.js");
  });
  it("finds the key in a chunk", () => {
    expect(findKey(`x={BASE:"u",API_KEY:"${FAKE_KEY}",Y:1}`)).toBe(FAKE_KEY);
    expect(findKey("API_KEY:short")).toBeUndefined();
  });
  it("discovers once, caches, and prefers the env var", async () => {
    const seen: string[] = [];
    const t: Transport = async (r) => {
      seen.push(r.url);
      if (r.url === SCHEDULES_MF) return res(200, entry);
      if (r.url.includes("165.")) return res(200, `a={API_KEY:"${FAKE_KEY}"}`);
      return res(200, "nothing here");
    };
    const p = new ApiKeyProvider(t, undefined);
    expect(await p.get()).toBe(FAKE_KEY);
    const n = seen.length;
    expect(await p.get()).toBe(FAKE_KEY);
    expect(seen.length).toBe(n);
    expect(await new ApiKeyProvider(t, "ENVKEY").get()).toBe("ENVKEY");
  });
  it("reports a blocked site as CINES_BLOCKED", async () => {
    const p = new ApiKeyProvider(async () => res(403, CF_BLOCK_HTML), undefined);
    await expect(p.get()).rejects.toMatchObject({ code: "CINES_BLOCKED" });
  });
});

function fakeClient(handler: (r: HttpRequest) => HttpResponse) {
  const reqs: HttpRequest[] = [];
  const t: Transport = async (r) => {
    reqs.push(r);
    return handler(r);
  };
  const client = new GraphQLClient({ transport: t, apiKey: new ApiKeyProvider(t, "KEY"), minIntervalMs: 0 });
  return { client, reqs };
}

describe("GraphQLClient", () => {
  const vars = { country_id: "MX", cinemas: "a" };
  it("sends the site's headers and operation and returns data", async () => {
    const { client, reqs } = fakeClient(() => res(200, JSON.stringify({ data: { cinemasById: { edges: [] } } })));
    const d = await client.call<{ cinemasById: unknown }>(CINEMAS, vars);
    expect(d.cinemasById).toEqual({ edges: [] });
    const r = reqs[0]!;
    expect(r.url).toBe("https://api-g.cinepolis.com/shared-services/locations/graphql");
    expect(r.headers?.["x-apikey"]).toBe("KEY");
    expect(r.headers?.["country-id"]).toBe("MX");
    expect(JSON.parse(r.body!).operationName).toBe("Cinemas");
    expect(r.headers?.Authorization).toBeUndefined();
  });
  it("maps failures to the shared error codes", async () => {
    const cases: [HttpResponse, string, boolean][] = [
      [res(403, CF_BLOCK_HTML, { server: "cloudflare" }), "CINES_BLOCKED", false],
      [res(503, "{}"), "CINES_UNAVAILABLE", true],
      [res(200, '{"errors":[{"message":"Cannot query field \\"x\\" on type \\"Y\\"","extensions":{"code":"GRAPHQL_VALIDATION_FAILED"}}]}'), "CINES_SCHEMA_CHANGED", false],
      [res(200, '{"data":null}'), "CINES_SCHEMA_CHANGED", false],
      [res(200, "<html>down</html>"), "CINES_SCHEMA_CHANGED", false],
    ];
    for (const [r, code, retryable] of cases) {
      const { client } = fakeClient(() => r);
      const err = await client.call(CINEMAS, vars).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CinesError);
      expect((err as CinesError).toJSON()).toEqual({ error: { code, message: expect.any(String), retryable } });
    }
  });
  it("re-discovers the API key once on 401 for public calls", async () => {
    let n = 0;
    const { client } = fakeClient(() => (++n === 1 ? res(401, "{}") : res(200, '{"data":{"ok":true}}')));
    await expect(client.call(CINEMAS, vars)).resolves.toEqual({ ok: true });
    expect(n).toBe(2);
  });
  it("treats 401 on member calls as an expired session", async () => {
    const { client } = fakeClient(() => res(401, "{}"));
    await expect(client.call(CINEMAS, vars, { accessToken: "jwt" })).rejects.toMatchObject({ code: "CINES_SESSION_EXPIRED" });
  });
  it("network errors are retryable outages", async () => {
    const t: Transport = async () => {
      throw new Error("ECONNRESET");
    };
    const client = new GraphQLClient({ transport: t, apiKey: new ApiKeyProvider(t, "KEY"), minIntervalMs: 0 });
    await expect(client.call(CINEMAS, vars)).rejects.toMatchObject({ code: "CINES_UNAVAILABLE", retryable: true });
  });
});
