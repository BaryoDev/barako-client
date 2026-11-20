import { callOpts, type CallOptions } from "../http";
import type { Transport } from "../transport";
import type { TokenStore } from "../auth";
import type { AuthTokens, Paged, TenantSummary } from "../types";
import { allPages } from "./all-pages";

export interface MeResource {
  /** The tenants the signed-in user belongs to. */
  tenants(opts?: CallOptions): Promise<TenantSummary[]>;
  /** Swap the current token for one scoped to another tenant the user belongs to. Stores the new
   *  access token and keeps the existing refresh token, which covers every tenant the user belongs
   *  to. JWT auth only (API keys are already tenant-bound). */
  switch(tenantSlug: string, opts?: CallOptions): Promise<AuthTokens>;
}

export function meResource(transport: Transport, store: TokenStore): MeResource {
  return {
    tenants: (opts) =>
      allPages((query) =>
        transport.request<Paged<TenantSummary>>({ method: "GET", path: "/api/me/tenants", query, ...callOpts(opts) }),
      ),

    async switch(tenantSlug, opts) {
      const tokens = await transport.request<AuthTokens>({
        method: "POST",
        path: "/api/me/switch",
        body: { club: tenantSlug },
        ...callOpts(opts),
      });
      // barakoCMS returns an empty refresh token here: the one from sign-in covers every tenant.
      // An older API still returns a new one, and then it replaces the stored one.
      // Passing the stored one back keeps it even in a store that replaces its state on set.
      store.set({ token: tokens.token, refreshToken: tokens.refreshToken || store.get().refreshToken });
      return tokens;
    },
  };
}
