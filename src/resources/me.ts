import type { Transport } from "../transport";
import type { TokenStore } from "../auth";
import type { AuthTokens, TenantSummary } from "../types";

export interface MeResource {
  /** The tenants the signed-in user belongs to. */
  tenants(): Promise<TenantSummary[]>;
  /** Swap the current token for one scoped to another tenant the user belongs to. Stores the new
   *  token. JWT auth only (API keys are already tenant-bound). */
  switch(tenantSlug: string): Promise<AuthTokens>;
}

export function meResource(transport: Transport, store: TokenStore): MeResource {
  return {
    tenants: () => transport.request<TenantSummary[]>({ method: "GET", path: "/api/me/tenants" }),

    async switch(tenantSlug) {
      const tokens = await transport.request<AuthTokens>({
        method: "POST",
        path: "/api/me/switch",
        body: { club: tenantSlug },
      });
      store.set({ token: tokens.token, refreshToken: tokens.refreshToken });
      return tokens;
    },
  };
}
