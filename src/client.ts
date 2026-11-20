import {
  ApiKeyAuthenticator,
  JwtAuthenticator,
  memoryStore,
  type Authenticator,
  type TokenStore,
} from "./auth";
import { createContractMonitor, type ContractMismatch } from "./contract";
import { resolveTimeouts, type HttpLimits, type Timeouts } from "./http";
import { Transport } from "./transport";
import { authResource, type AuthResource } from "./resources/auth";
import { meResource, type MeResource } from "./resources/me";
import { contentsResource, type ContentsResource } from "./resources/contents";
import { contentTypesResource, type ContentTypesResource } from "./resources/content-types";
import { blocksResource, type BlocksResource } from "./resources/blocks";
import { pagesResource, type PagesResource } from "./resources/pages";
import { publicResource, type PublicResource } from "./resources/public";

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
  /** Timeouts in milliseconds, covering headers and body. Reads (GET, HEAD) default to 30000. Writes
   *  (every other method) default to 0, no limit. 0 turns one off. A request that runs out gets a
   *  BarakoError with code `timeout`. The token refresh counts as a read. */
  timeouts?: Timeouts;
  /** Aborts every request of this client when it fires. A request stopped this way gets a
   *  BarakoError with code `aborted`. */
  signal?: AbortSignal;
  /** Called once per surface (`admin`, `delivery`) when the API's contract version is outside the
   *  range this client supports. Without it the client logs one `console.warn`. It never changes
   *  the result of a request. */
  onContractMismatch?: (info: ContractMismatch) => void;
}

export interface BarakoClient {
  auth: AuthResource;
  me: MeResource;
  contents: ContentsResource;
  contentTypes: ContentTypesResource;
  blocks: BlocksResource;
  pages: PagesResource;
  /** Anonymous public delivery for a website frontend (no auth needed). */
  public: PublicResource;
}

/**
 * Create a barakoCMS client. Framework-agnostic; runs anywhere fetch does.
 *
 * ```ts
 * // machine caller: an API key
 * const cms = createClient({ baseUrl, apiKey: "bcms_..." });
 * const posts = await cms.contents.list({ contentType: "post" });
 *
 * // human app: log in, tokens refresh automatically
 * const cms = createClient({ baseUrl });
 * await cms.auth.login("user", "pass");
 * ```
 */
export function createClient(config: ClientConfig): BarakoClient {
  if (!config.baseUrl) throw new Error("createClient: baseUrl is required.");
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("createClient: no global fetch here, pass config.fetch.");
  }

  const timeouts = resolveTimeouts(config.timeouts);
  const limits: HttpLimits = {
    timeouts,
    signal: config.signal,
    onResponse: createContractMonitor(config.onContractMismatch),
  };

  const store =
    config.storage ?? memoryStore({ token: config.token, refreshToken: config.refreshToken });

  const auth: Authenticator = config.apiKey
    ? new ApiKeyAuthenticator(config.apiKey)
    : new JwtAuthenticator(store, config.baseUrl, fetchImpl, config.tenant, limits);

  const transport = new Transport(config.baseUrl, auth, fetchImpl, limits);

  return {
    auth: authResource(transport, store),
    me: meResource(transport, store),
    contents: contentsResource(transport),
    contentTypes: contentTypesResource(transport),
    blocks: blocksResource(transport),
    pages: pagesResource(transport),
    public: publicResource(transport, config.baseUrl),
  };
}
