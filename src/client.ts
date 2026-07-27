import {
  ApiKeyAuthenticator,
  JwtAuthenticator,
  memoryStore,
  type Authenticator,
  type TokenStore,
} from "./auth";
import { Transport } from "./transport";
import { authResource, type AuthResource } from "./resources/auth";
import { meResource, type MeResource } from "./resources/me";
import { contentsResource, type ContentsResource } from "./resources/contents";
import { contentTypesResource, type ContentTypesResource } from "./resources/content-types";

export interface ClientConfig {
  /** API base URL, e.g. https://playground.baryo.dev/barakocms-api */
  baseUrl: string;
  /** API-key auth: a `bcms_...` key. The server derives the tenant, so no login and no X-Tenant. */
  apiKey?: string;
  /** JWT auth: start with an existing access token (and optional refresh token) instead of logging in. */
  token?: string;
  refreshToken?: string;
  /** Force the X-Tenant for JWT auth (otherwise derived from the token's claim). Ignored for API keys. */
  tenant?: string;
  /** Where JWT tokens live between requests. Defaults to an in-memory store. Use browserStore() in a browser. */
  storage?: TokenStore;
  /** Custom fetch (for Node <18, tests, or interception). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface BarakoClient {
  auth: AuthResource;
  me: MeResource;
  contents: ContentsResource;
  contentTypes: ContentTypesResource;
}

/**
 * Create a barakoCMS client. Framework-agnostic; runs anywhere fetch does.
 *
 * ```ts
 * // machine caller — an API key
 * const cms = createClient({ baseUrl, apiKey: "bcms_..." });
 * const posts = await cms.contents.list({ contentType: "post" });
 *
 * // human app — log in, tokens refresh automatically
 * const cms = createClient({ baseUrl });
 * await cms.auth.login("user", "pass");
 * ```
 */
export function createClient(config: ClientConfig): BarakoClient {
  if (!config.baseUrl) throw new Error("createClient: baseUrl is required.");
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("createClient: no fetch available — pass config.fetch (Node < 18).");
  }

  const store =
    config.storage ?? memoryStore({ token: config.token, refreshToken: config.refreshToken });

  const auth: Authenticator = config.apiKey
    ? new ApiKeyAuthenticator(config.apiKey)
    : new JwtAuthenticator(store, config.baseUrl, fetchImpl, config.tenant);

  const transport = new Transport(config.baseUrl, auth, fetchImpl);

  return {
    auth: authResource(transport, store),
    me: meResource(transport, store),
    contents: contentsResource(transport),
    contentTypes: contentTypesResource(transport),
  };
}
