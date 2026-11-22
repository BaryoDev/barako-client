import { BarakoError } from "./errors";
import { fetchText, invalidJson, toError, waitBounded, type CallOptions, type HttpLimits } from "./http";
import type { AuthTokens } from "./types";

/** Where JWT tokens are kept between requests. Swap in a browser (localStorage) or persistent store. */
export interface TokenStore {
  get(): { token?: string; refreshToken?: string };
  /** Merges: a key left out keeps its stored value. `me.switch()` sets only `token` and relies on
   *  the stored refresh token surviving, so a custom store must not replace the whole state here. */
  set(tokens: { token?: string; refreshToken?: string }): void;
  clear(): void;
}

/** In-memory store, the default, right for servers, scripts, and tests. */
export function memoryStore(initial?: { token?: string; refreshToken?: string }): TokenStore {
  let state = { ...initial };
  return {
    get: () => ({ ...state }),
    set: (tokens) => {
      state = { ...state, ...tokens };
    },
    clear: () => {
      state = {};
    },
  };
}

/**
 * localStorage-backed store for browser apps. Persists across reloads and tabs.
 *
 * Note: this keeps the refresh token in localStorage, which any script running on the page can
 * read, so an XSS leaks it. Prefer the default in-memory store (`memoryStore()`) or a cookie-based
 * refresh flow when you can.
 */
export function browserStore(prefix = "barako"): TokenStore {
  const tk = `${prefix}_token`;
  const rk = `${prefix}_refresh`;
  return {
    get: () => ({
      token: localStorage.getItem(tk) ?? undefined,
      refreshToken: localStorage.getItem(rk) ?? undefined,
    }),
    set: ({ token, refreshToken }) => {
      if (token !== undefined) localStorage.setItem(tk, token);
      if (refreshToken !== undefined) localStorage.setItem(rk, refreshToken);
    },
    clear: () => {
      localStorage.removeItem(tk);
      localStorage.removeItem(rk);
    },
  };
}

/** The tenant a JWT was minted for, read from its `tenant` claim. Null for an API key or a legacy
 *  token with no claim. Isomorphic base64url decode (browser atob / Node Buffer). */
export function tenantOfToken(token?: string): string | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = base64UrlDecode(payload);
    const claims = JSON.parse(json) as { tenant?: unknown };
    return typeof claims.tenant === "string" ? claims.tenant : null;
  } catch {
    return null;
  }
}

function base64UrlDecode(input: string): string {
  // atob, Uint8Array and TextDecoder are all global in Node 18+ and browsers, so this is isomorphic
  // and UTF-8 correct (atob alone would mangle non-ASCII claim values).
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** How the transport authenticates each request and recovers from a 401. */
export interface Authenticator {
  /** Current `Authorization` header value, or undefined if unauthenticated. */
  authHeader(): string | undefined;
  /** `X-Tenant` header to send, or undefined. */
  tenantHeader(): string | undefined;
  /** Called on a 401, with the failed call's own signal and timeoutMs, which bound how long that
   *  caller waits. Return true if the caller should retry the request (e.g. after a refresh).
   *  Rejects with a BarakoError when the recovery itself failed in a way that says nothing about the
   *  credential (a 5xx, a timeout), so the caller sees that failure and the tokens stay. */
  recover(call?: CallOptions): Promise<boolean>;
}

/** API-key auth: a static bearer token, no refresh. The server derives the tenant from the key, so
 *  the SDK sends no X-Tenant. */
export class ApiKeyAuthenticator implements Authenticator {
  constructor(private readonly apiKey: string) {}
  authHeader() {
    return `Bearer ${this.apiKey}`;
  }
  tenantHeader() {
    return undefined;
  }
  async recover(_call?: CallOptions) {
    return false; // a bad/expired key can't be refreshed
  }
}

/** JWT auth: bearer from the store, single-flight refresh on 401, tenant from the token claim
 *  (or an explicit override). */
export class JwtAuthenticator implements Authenticator {
  private refreshing?: Promise<boolean>;

  constructor(
    private readonly store: TokenStore,
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch,
    private readonly tenantOverride?: string,
    private readonly limits: HttpLimits = { timeouts: { readMs: 0, writeMs: 0 } },
    private readonly guard: () => void = () => {},
  ) {}

  authHeader() {
    const { token } = this.store.get();
    return token ? `Bearer ${token}` : undefined;
  }

  tenantHeader() {
    return this.tenantOverride ?? tenantOfToken(this.store.get().token) ?? undefined;
  }

  async recover(call?: CallOptions) {
    // Concurrent 401s share one refresh so we don't trip the server's refresh-token reuse detection.
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    // The refresh runs on the client's limits, so one caller leaving does not cancel it for the
    // others. This caller's own signal and timeoutMs only bound how long it waits.
    return waitBounded(this.refreshing, { signals: [call?.signal], timeoutMs: call?.timeoutMs }, "Token refresh failed.");
  }

  private async doRefresh(): Promise<boolean> {
    const { refreshToken, token } = this.store.get();
    if (!refreshToken) return false;

    // Carry the tenant into the refresh, or the new token silently reverts to the default tenant.
    const tenant = this.tenantOverride ?? tenantOfToken(token) ?? undefined;
    const path = "/api/auth/refresh";
    this.guard();
    let res;
    try {
      res = await fetchText(
        this.fetchImpl,
        `${this.baseUrl}${path}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(tenant ? { "X-Tenant": tenant } : {}),
          },
          body: JSON.stringify({ refreshToken }),
          redirect: "error",
        },
        // The refresh is a POST but takes the read timeout, not the write one. Every request that
        // got a 401 waits on this one refresh, so a hung refresh with no limit would hang them all.
        { signals: [this.limits.signal], timeoutMs: this.limits.timeouts.readMs },
      );
    } catch (e) {
      // The tokens stay: a timeout or a network error says nothing about them.
      if (e instanceof BarakoError) {
        throw new BarakoError(e.status, `Token refresh failed. ${e.message}`, e.body, {
          code: e.code,
          outcomeUnknown: e.outcomeUnknown,
        });
      }
      throw e;
    }
    this.limits.onResponse?.(path, res.headers);

    // A logout, a login or a tenant switch during the refresh changed the session. This answer is for
    // the old one, so it must not clear or overwrite the current one. The caller gets false.
    const sessionChanged = () => {
      const now = this.store.get();
      return now.refreshToken !== refreshToken || now.token !== token;
    };

    // Only a 400 or 401 says the refresh token is bad. Anything else is the server or the network
    // having a bad moment, and signing the user out for it would lose a good session.
    if (res.status === 400 || res.status === 401) {
      if (!sessionChanged()) this.store.clear();
      return false;
    }
    if (!res.ok) {
      // Keep the refresh's status, but say it was the refresh, so a 403 here is not read as the
      // caller's own request being forbidden.
      const e = toError(res);
      throw new BarakoError(e.status, `Token refresh failed. ${e.message}`, e.body);
    }

    let data: AuthTokens;
    try {
      data = JSON.parse(res.text) as AuthTokens;
    } catch {
      throw invalidJson(res.status, res.text);
    }
    if (!data || typeof data !== "object") throw invalidJson(res.status, res.text);
    // A 200 with no access token is not an answer to use. The tokens stay, and the body is left out
    // of the error because it holds the new refresh token.
    if (typeof data.token !== "string" || !data.token) throw invalidJson(res.status, "");
    // A refresh always rotates, so the token just sent is used. Keeping it would make the next
    // refresh a replay, which revokes every session the user has.
    if (sessionChanged()) return false;
    if (!data.refreshToken) {
      this.store.clear();
      return false;
    }
    this.store.set({ token: data.token, refreshToken: data.refreshToken });
    return true;
  }
}
