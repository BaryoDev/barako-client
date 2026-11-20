import type { Authenticator } from "./auth";
import { callOpts, fetchText, invalidJson, isRead, resolveTimeout, toError, type CallOptions, type HttpLimits, type TextResponse } from "./http";

export interface RequestOptions extends CallOptions {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Extra headers for this request (e.g. X-Tenant on login). */
  headers?: Record<string, string>;
  /** Skip auth recovery/retry (used by the auth endpoints themselves). */
  noRetry?: boolean;
  /** Count this request as a read for the timeout and the outcome note, whatever its method. For a
   *  request that saves nothing (a login, a dry run). */
  read?: boolean;
}

/** The HTTP layer: builds requests, attaches auth + tenant headers, retries once after a recovered
 *  401, and turns non-2xx into a typed BarakoError. Uses the global fetch (Node 18+, browsers, edge)
 *  unless a custom one is supplied. Every request is bounded by a timeout and can be aborted. It
 *  never retries after a timeout or a network error. */
export class Transport {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: Authenticator,
    private readonly fetchImpl: typeof fetch,
    private readonly limits: HttpLimits = { timeouts: { readMs: 0, writeMs: 0 } },
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async request<T>(opts: RequestOptions): Promise<T> {
    return (await this.requestWithHeaders<T>(opts)).body;
  }

  /** Same as request, but also returns the response headers (for ETag and the like). */
  async requestWithHeaders<T>(opts: RequestOptions): Promise<{ body: T; headers: Headers }> {
    let res = await this.send(opts);

    if (res.status === 401 && !opts.noRetry && (await this.auth.recover(callOpts(opts)))) {
      res = await this.send(opts); // retry once with the refreshed credential
    }

    if (!res.ok) {
      throw toError(res);
    }

    // 204 and empty bodies deserialize to undefined.
    if (res.status === 204 || !res.text) return { body: undefined as T, headers: res.headers };
    let body: T;
    try {
      body = JSON.parse(res.text) as T;
    } catch {
      throw invalidJson(res.status, res.text);
    }
    return { body, headers: res.headers };
  }

  private async send(opts: RequestOptions): Promise<TextResponse> {
    const url = this.baseUrl + opts.path + queryString(opts.query);
    const headers: Record<string, string> = {};

    const auth = this.auth.authHeader();
    if (auth) headers["Authorization"] = auth;
    const tenant = this.auth.tenantHeader();
    if (tenant) headers["X-Tenant"] = tenant;
    // Per-request headers win (e.g. X-Tenant on login before a token exists).
    Object.assign(headers, opts.headers);

    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const read = opts.read ?? isRead(opts.method);
    const res = await fetchText(
      this.fetchImpl,
      url,
      { method: opts.method, headers, body },
      {
        signals: [this.limits.signal, opts.signal],
        timeoutMs: resolveTimeout(opts.timeoutMs, read ? this.limits.timeouts.readMs : this.limits.timeouts.writeMs),
        read,
      },
    );
    this.limits.onResponse?.(opts.path, res.headers);
    return res;
  }
}

function queryString(query?: RequestOptions["query"]): string {
  if (!query) return "";
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}
