import type { Authenticator } from "./auth";
import { BarakoError } from "./errors";

export interface RequestOptions {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Extra headers for this request (e.g. X-Tenant on login). */
  headers?: Record<string, string>;
  /** Skip auth recovery/retry (used by the auth endpoints themselves). */
  noRetry?: boolean;
}

/** The HTTP layer: builds requests, attaches auth + tenant headers, retries once after a recovered
 *  401, and turns non-2xx into a typed BarakoError. Uses the global fetch (Node 18+, browsers, edge)
 *  unless a custom one is supplied. */
export class Transport {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: Authenticator,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async request<T>(opts: RequestOptions): Promise<T> {
    let res = await this.send(opts);

    if (res.status === 401 && !opts.noRetry && (await this.auth.recover())) {
      res = await this.send(opts); // retry once with the refreshed credential
    }

    if (!res.ok) {
      throw await this.toError(res);
    }

    // 204 and empty bodies deserialize to undefined.
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private send(opts: RequestOptions): Promise<Response> {
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

    return this.fetchImpl(url, { method: opts.method, headers, body });
  }

  private async toError(res: Response): Promise<BarakoError> {
    let body: unknown;
    let message = `${res.status} ${res.statusText}`;
    try {
      const text = await res.text();
      if (text) {
        try {
          body = JSON.parse(text);
          const m = (body as { message?: unknown })?.message;
          if (typeof m === "string" && m) message = m;
        } catch {
          body = text;
          message = text;
        }
      }
    } catch {
      // keep the status-line message
    }
    return new BarakoError(res.status, message, body);
  }
}

function queryString(query?: RequestOptions["query"]): string {
  if (!query) return "";
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}
