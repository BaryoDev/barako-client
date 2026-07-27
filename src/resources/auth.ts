import type { Transport } from "../transport";
import type { TokenStore } from "../auth";
import type { AuthTokens } from "../types";

export interface AuthResource {
  /** Sign in with a username and password. Optionally scope the token to a tenant (sent as X-Tenant).
   *  Stores the returned tokens. If the deployment requires device approval, the response has
   *  `deviceApprovalRequired: true` and no tokens — collect the emailed OTP and verify it. */
  login(username: string, password: string, tenant?: string): Promise<AuthTokens>;
  /** Revoke the refresh token server-side and clear the local store. */
  logout(): Promise<void>;
  /** Force a token refresh now. Normally automatic on a 401. */
  refresh(): Promise<AuthTokens>;
  /** Whether an access token is currently held. */
  readonly isAuthenticated: boolean;
}

export function authResource(transport: Transport, store: TokenStore): AuthResource {
  return {
    get isAuthenticated() {
      return Boolean(store.get().token);
    },

    async login(username, password, tenant) {
      const tokens = await transport.request<AuthTokens>({
        method: "POST",
        path: "/api/auth/login",
        body: { username, password },
        headers: tenant ? { "X-Tenant": tenant } : undefined,
        noRetry: true,
      });
      if (tokens?.token) store.set({ token: tokens.token, refreshToken: tokens.refreshToken });
      return tokens;
    },

    async logout() {
      const { refreshToken } = store.get();
      try {
        await transport.request<void>({
          method: "POST",
          path: "/api/auth/logout",
          body: refreshToken ? { refreshToken } : {},
          noRetry: true,
        });
      } finally {
        store.clear();
      }
    },

    async refresh() {
      const { refreshToken } = store.get();
      if (!refreshToken) throw new Error("No refresh token available.");
      const tokens = await transport.request<AuthTokens>({
        method: "POST",
        path: "/api/auth/refresh",
        body: { refreshToken },
        noRetry: true,
      });
      store.set({ token: tokens.token, refreshToken: tokens.refreshToken });
      return tokens;
    },
  };
}
