import { describe, expect, it } from "vitest";
import { redactHar } from "../src/safety/redact.js";
import { findCardNumbers, isSensitiveName, luhn, normalizeKey } from "../src/safety/patterns.js";
import { scanPathPolicy, scanText } from "../src/safety/scan.js";

// Fake secrets are assembled at runtime so this file itself passes check-secrets.
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = [b64({ alg: "RS256", typ: "JWT" }), b64({ sub: "auth0|abc", exp: 1 }), "c2lnbmF0dXJlLXNpZw"].join(".");
const FAKE_EMAIL = ["jane.doe", "gmail.com"].join("@");
const FAKE_CARD = ["4111", "1111", "1111", "1111"].join(" ");
const FAKE_APIKEY = "k".repeat(20) + "1234567890abcdefABCDEF1234";
const FAKE_PHONE = "+52 55 " + "1234 5678";
const PERSON = "Janeth Doelopez";

function syntheticHar() {
  return {
    log: {
      version: "1.2",
      creator: { name: "WebInspector", version: "537.36" },
      pages: [],
      entries: [
        {
          startedDateTime: "2026-10-19T20:59:52.000Z",
          request: {
            method: "POST",
            url: `https://api-g.example.invalid/v1/ticket/graphql?apikey=${FAKE_APIKEY}&countryId=MX`,
            headers: [
              { name: "x-apikey", value: FAKE_APIKEY },
              { name: "authorization", value: FAKE_JWT },
              { name: "cookie", value: "a=b" },
              { name: "content-type", value: "application/json" },
              { name: "country-id", value: "MX" },
              { name: ":path", value: `/v1/ticket/graphql?token=${FAKE_APIKEY}` },
            ],
            cookies: [{ name: "__cf_bm", value: "secretcookievalue123", expires: "2026-10-19T21:32:04.000Z", httpOnly: true }],
            queryString: [
              { name: "apikey", value: FAKE_APIKEY },
              { name: "countryId", value: "MX" },
            ],
            postData: {
              mimeType: "application/json",
              text: JSON.stringify({
                operationName: "Order",
                variables: {
                  sessionId: "12345",
                  orderSessionId: "c4fc3ea0-dff0-44e9-b103-ef753c45401a",
                  email: FAKE_EMAIL,
                  first_name: "Janeth",
                  last_name: "Doelopez",
                  note: `pay with ${FAKE_CARD} call ${FAKE_PHONE}`,
                  movie: { name: "Street Fighter" },
                },
                query: "mutation Order($orderData: OrderInput!) { order(orderData: $orderData) { total } }",
              }),
            },
          },
          response: {
            status: 200,
            headers: [{ name: "set-cookie", value: "__cf_bm=zzz; Path=/" }],
            cookies: [{ name: "AWSALB", value: "albvalue", expires: "2026-10-26T21:02:20.000Z" }],
            content: {
              mimeType: "application/json",
              text: JSON.stringify({
                data: {
                  member: { email: FAKE_EMAIL, nationalId: "XYZ", name: PERSON },
                  token: FAKE_JWT,
                  seats: { maxQuantity: 10 },
                  nested: JSON.stringify({ d: `owner ${FAKE_EMAIL}` }),
                },
              }),
            },
          },
          _initiator: { url: "https://x.invalid/?t=" + FAKE_APIKEY },
        },
        {
          request: { method: "GET", url: "https://img.example.invalid/a.png", headers: [] },
          response: { status: 200, headers: [], content: { mimeType: "image/png", encoding: "base64", text: "iVBORw0KGgo=" } },
        },
      ],
    },
  };
}

describe("patterns", () => {
  it("normalizes camelCase keys", () => {
    expect(normalizeKey("orderSessionId")).toBe("order_session_id");
    expect(normalizeKey("x-apikey")).toBe("x_apikey");
  });
  it("treats auth headers as sensitive but public ids as not", () => {
    expect(isSensitiveName("x-apikey")).toBe(true);
    expect(isSensitiveName("Authorization")).toBe(true);
    expect(isSensitiveName("orderSessionId")).toBe(true);
    expect(isSensitiveName("refresh_token")).toBe(true);
    expect(isSensitiveName("sessionId")).toBe(false);
    expect(isSensitiveName("country-id")).toBe(false);
  });
  it("detects Luhn-valid card numbers only", () => {
    expect(luhn(FAKE_CARD.replace(/ /g, ""))).toBe(true);
    expect(findCardNumbers(`x ${FAKE_CARD} y`)).toHaveLength(1);
    expect(findCardNumbers("1785343500000")).toHaveLength(0); // epoch ms
    expect(findCardNumbers("4111111111111112")).toHaveLength(0);
    expect(findCardNumbers('"time": 2.21800000872463,')).toHaveLength(0);
    expect(findCardNumbers('"send": 0.04200000000000026')).toHaveLength(0);
  });
});

describe("redactHar", () => {
  const { har, stats } = redactHar(syntheticHar(), { salt: "test", literals: [PERSON] });
  const text = JSON.stringify(har);

  it("removes every planted secret class", () => {
    for (const secret of [FAKE_JWT, FAKE_EMAIL, FAKE_APIKEY, "4111", "1234 5678", "Janeth", "Doelopez", "secretcookievalue123", "albvalue", "c4fc3ea0"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("keeps names, attributes and public structure", () => {
    expect(text).toContain('"name":"x-apikey"');
    expect(text).toContain('"name":"__cf_bm"');
    expect(text).toContain("2026-10-19T21:32:04.000Z");
    expect(text).toContain("Street Fighter");
    expect(text).toContain('\\"sessionId\\":\\"12345\\"');
    expect(text).toContain("countryId=MX");
    expect(text).toContain("maxQuantity");
    expect(text).not.toContain("_initiator");
    expect(stats.binaryBodiesDropped).toBe(1);
  });

  it("is deterministic for a given salt (equal values correlate)", () => {
    const again = JSON.stringify(redactHar(syntheticHar(), { salt: "test", literals: [PERSON] }).har);
    expect(again).toBe(text);
  });

  it("produces output that passes the secret scanner", () => {
    const findings = scanText("out.har", JSON.stringify(har, null, 1), { literals: [PERSON] }).filter(
      (f) => f.kind !== "unredacted-har-content",
    );
    expect(findings).toEqual([]);
  });

  it("rejects non-HAR input", () => {
    expect(() => redactHar({ foo: 1 })).toThrow(/Not a HAR/);
  });

  it("scrubs cookie values wherever else they appear", () => {
    const input = {
      log: {
        entries: [
          {
            request: {
              method: "GET",
              url: "https://pixel.example.invalid/img.gif?c=rcookievalue99&t=1",
              headers: [{ name: ":path", value: "/img.gif?c=rcookievalue99" }],
              cookies: [{ name: "rCookie", value: "rcookievalue99" }],
            },
            response: { status: 200, headers: [], content: { mimeType: "text/plain", text: "echo rcookievalue99" } },
          },
        ],
      },
    };
    expect(JSON.stringify(redactHar(input, { salt: "t" }).har)).not.toContain("rcookievalue99");
  });

  it("drops tracker payloads and hashes their query values", () => {
    const input = {
      log: {
        entries: [
          {
            request: {
              method: "POST",
              url: "https://www.facebook.com/tr/?id=1890150388495994&ev=PageView",
              headers: [],
              queryString: [{ name: "ev", value: "PageView" }],
              postData: { mimeType: "application/x-www-form-urlencoded", text: "rid=3102121059994086&fp=abc" },
            },
            response: { status: 200, headers: [], content: { mimeType: "text/plain", text: "fingerprint-xyz" } },
          },
        ],
      },
    };
    const { har: out, stats: s } = redactHar(input, { salt: "t" });
    const t = JSON.stringify(out);
    expect(s.trackerEntries).toBe(1);
    for (const v of ["1890150388495994", "PageView", "3102121059994086", "fingerprint-xyz"]) expect(t).not.toContain(v);
    expect(t).toContain("www.facebook.com/tr/");
  });
});

describe("scanner", () => {
  it("flags planted secrets", () => {
    const src = [
      `const t = "${FAKE_JWT}";`,
      `email: ${FAKE_EMAIL}`,
      `card ${FAKE_CARD}`,
      `"x-apikey": "${FAKE_APIKEY}"`,
      `tel ${FAKE_PHONE}`,
      `owner ${PERSON}`,
    ].join("\n");
    const kinds = scanText("a.ts", src, { literals: [PERSON] }).map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(["jwt", "email", "card-number", "api-key", "phone", "literal"]));
  });
  it("never echoes a full secret", () => {
    const f = scanText("a.ts", `x ${FAKE_JWT}`)[0];
    expect(f?.excerpt).not.toContain(FAKE_JWT);
  });
  it("allows example and noreply addresses", () => {
    expect(scanText("a.md", "mail me@example.com or 1+x@users.noreply.github.com")).toEqual([]);
  });
  it("blocks HAR, env and stray images by path", () => {
    expect(scanPathPolicy("captures/flow.har").map((f) => f.kind)).toContain("har-file");
    expect(scanPathPolicy(".env").map((f) => f.kind)).toContain("env-file");
    expect(scanPathPolicy(".env.example")).toEqual([]);
    expect(scanPathPolicy("docs/seat.png").map((f) => f.kind)).toContain("image-outside-golden");
    expect(scanPathPolicy("test/golden/seat.png")).toEqual([]);
  });
  it("flags raw HAR content", () => {
    const raw = JSON.stringify({ log: { version: "1.2", entries: [] } });
    expect(scanText("x.json", raw).map((f) => f.kind)).toContain("unredacted-har-content");
  });
});
