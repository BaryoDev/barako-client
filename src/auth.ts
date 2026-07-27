import type { AuthTokens } from "./types";

/** Where JWT tokens are kept between requests. Swap in a browser (localStorage) or persistent store. */
export interface TokenStore {
  get(): { token?: string; refreshToken?: string };
  set(tokens: { token?: string; refreshToken?: string }): void;
  clear(): void;
}

/** In-memory store — the default, right for servers, scripts, and tests. */
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

/** localStorage-backed store for browser apps. Persists across reloads and tabs. */
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
  /** Called on a 401. Return true if the caller should retry the request (e.g. after a refresh). */
  recover(): Promise<boolean>;
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
  async recover() {
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
  ) {}

  authHeader() {
    const { token } = this.store.get();
    return token ? `Bearer ${token}` : undefined;
  }

  tenantHeader() {
    return this.tenantOverride ?? tenantOfToken(this.store.get().token) ?? undefined;
  }

  async recover() {
    // Concurrent 401s share one refresh so we don't trip the server's refresh-token reuse detection.
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const { refreshToken, token } = this.store.get();
    if (!refreshToken) return false;

    // Carry the tenant into the refresh, or the new token silently reverts to the default tenant.
    const tenant = this.tenantOverride ?? tenantOfToken(token) ?? undefined;
    const res = await this.fetchImpl(`${this.baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(tenant ? { "X-Tenant": tenant } : {}),
      },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) {
      this.store.clear();
      return false;
    }
    const data = (await res.json()) as AuthTokens;
    this.store.set({ token: data.token, refreshToken: data.refreshToken });
    return true;
  }
}
