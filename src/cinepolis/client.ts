/**
 * GraphQL client for api-g.cinepolis.com.
 */
import { CinesError } from "../errors.js";
import { classify, errorFor } from "../http/classify.js";
import { Pacer } from "../http/pacer.js";
import { httpsTransport, type Transport } from "../http/transport.js";
import { ApiKeyProvider } from "./apikey.js";
import type { Operation } from "./queries.js";

export const API_BASE = "https://api-g.cinepolis.com";

export interface GraphQLClientOptions {
  transport?: Transport;
  apiKey?: ApiKeyProvider;
  /** Minimum spacing between requests (default 350 ms, ~3 rps). */
  minIntervalMs?: number;
  countryId?: string;
  language?: string;
  base?: string;
}

export interface CallOptions {
  /** Auth0 access token for member-only operations. Never logged. */
  accessToken?: string;
  /** Skip in-flight de-duplication (mutations). */
  noDedupe?: boolean;
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: { message?: string; extensions?: { code?: string } }[];
}

export class GraphQLClient {
  private readonly transport: Transport;
  private readonly apiKey: ApiKeyProvider;
  private readonly pacer: Pacer;
  readonly countryId: string;
  private readonly language: string;
  private readonly base: string;

  constructor(opts: GraphQLClientOptions = {}) {
    this.transport = opts.transport ?? httpsTransport;
    this.apiKey = opts.apiKey ?? new ApiKeyProvider(this.transport);
    this.pacer = new Pacer(opts.minIntervalMs ?? 350);
    this.countryId = opts.countryId ?? "MX";
    this.language = opts.language ?? "es-MX";
    this.base = opts.base ?? API_BASE;
  }

  async call<T>(op: Operation, variables: Record<string, unknown>, opts: CallOptions = {}): Promise<T> {
    const body = JSON.stringify({ operationName: op.operationName, variables, query: op.query });
    const key = opts.noDedupe || opts.accessToken ? undefined : `${op.path}|${body}`;
    return this.pacer.run(key, () => this.send<T>(op, body, opts, true));
  }

  private async send<T>(op: Operation, body: string, opts: CallOptions, mayRetryKey: boolean): Promise<T> {
    const apiKey = await this.apiKey.get();
    const headers: Record<string, string> = {
      Accept: "*/*",
      "Content-Type": "application/json",
      Origin: "https://cinepolis.com",
      Referer: "https://cinepolis.com/",
      "country-id": this.countryId,
      language: this.language,
      "x-apikey": apiKey,
    };
    if (opts.accessToken) headers.Authorization = opts.accessToken;
    let res;
    try {
      res = await this.transport({ url: `${this.base}${op.path}`, method: "POST", headers, body });
    } catch (e) {
      throw new CinesError("CINES_UNAVAILABLE", `Could not reach Cinépolis (${op.operationName})`, { retryable: true, cause: e });
    }
    const c = classify(res);
    if (c.kind === "unauthorized" && !opts.accessToken && mayRetryKey) {
      // The public API key rotated: discover it again once.
      this.apiKey.invalidate();
      return this.send<T>(op, body, opts, false);
    }
    if (c.kind !== "ok") throw errorFor(c, res, op.operationName);
    let json: GraphQLResponse<T>;
    try {
      json = JSON.parse(res.text) as GraphQLResponse<T>;
    } catch {
      throw new CinesError("CINES_SCHEMA_CHANGED", `Invalid JSON from Cinépolis (${op.operationName})`);
    }
    if (json.errors?.length) {
      const msg = json.errors.map((e) => e.message ?? "error").join("; ").slice(0, 300);
      const codes = json.errors.map((e) => e.extensions?.code ?? "");
      if (codes.some((c) => /UNAUTH/i.test(c)) || /unauthori[sz]ed|jwt|token/i.test(msg)) {
        throw new CinesError("CINES_SESSION_EXPIRED", `Cinépolis session rejected (${op.operationName})`);
      }
      if (codes.includes("GRAPHQL_VALIDATION_FAILED") || /Cannot query field|Unknown argument|Unknown type/i.test(msg)) {
        throw new CinesError("CINES_SCHEMA_CHANGED", `Cinépolis API changed (${op.operationName}): ${msg}`);
      }
      if (/not found|no existe|no est[aá] disponible/i.test(msg)) throw new CinesError("CINES_NOT_FOUND", `${op.operationName}: ${msg}`);
      const classes = json.errors.map((e) => (e.extensions as { classification?: string } | undefined)?.classification ?? "");
      if (classes.includes("INTERNAL_ERROR") || (!json.data && /unexpected error|try again/i.test(msg))) {
        throw new CinesError("CINES_UNAVAILABLE", `Cinépolis failed to answer ${op.operationName}; try again later`, { retryable: true });
      }
      if (!json.data) throw new CinesError("CINES_BAD_REQUEST", `${op.operationName}: ${msg}`);
    }
    if (json.data === undefined || json.data === null) {
      throw new CinesError("CINES_SCHEMA_CHANGED", `Empty data from Cinépolis (${op.operationName})`);
    }
    return json.data;
  }
}
