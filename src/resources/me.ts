import type { Transport } from "../transport";
import { keepingRefreshToken, type TokenStore } from "../auth";
import type { AuthTokens, Paged, TenantSummary } from "../types";
import { allPages } from "./all-pages";

export interface MeResource {
  /** The tenants the signed-in user belongs to. */
  tenants(): Promise<TenantSummary[]>;
  /** Swap the current token for one scoped to another tenant the user belongs to. Stores the new
   *  access token and keeps the existing refresh token, which covers every tenant the user belongs
   *  to. JWT auth only (API keys are already tenant-bound). */
  switch(tenantSlug: string): Promise<AuthTokens>;
}

export function meResource(transport: Transport, store: TokenStore): MeResource {
  return {
    tenants: () =>
      allPages((query) =>
        transport.request<Paged<TenantSummary>>({ method: "GET", path: "/api/me/tenants", query }),
      ),

    async switch(tenantSlug) {
      const tokens = await transport.request<AuthTokens>({
        method: "POST",
        path: "/api/me/switch",
        body: { club: tenantSlug },
      });
      store.set(keepingRefreshToken(tokens));
      return tokens;
    },
  };
}
