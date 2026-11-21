import { pathSegment } from "./path";
import { callOpts, type CallOptions } from "./http";
import type { RequestOptions, Transport } from "./transport";

export type ResourceMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One route of a resource. `path` is a template whose only placeholder is `{id}`. */
export interface ResourceRoute {
  method: ResourceMethod;
  path: string;
  /** True when the server's route accepts a dry run. Allowed on create and update only. */
  dryRun?: boolean;
  /** On update only: the row keeps its fields under `data`, so a change is merged into it. Without
   *  this, a change is a set of named top-level fields. The only value is "data". */
  merge?: "data";
}

/** A resource the generic verbs can reach: a name and one route per verb it supports. */
export interface ResourceDefinition {
  name: string;
  list?: ResourceRoute;
  get?: ResourceRoute;
  create?: ResourceRoute;
  update?: ResourceRoute;
  delete?: ResourceRoute;
}

export type ResourceVerb = "list" | "get" | "create" | "update" | "delete";

export const RESOURCE_VERBS: readonly ResourceVerb[] = ["list", "get", "create", "update", "delete"];

export interface ResourceCallOptions extends CallOptions {
  /** Fills `{id}`. Needed on get, update and delete, refused on list and create. */
  id?: string;
  /** The request body. Create and update only. */
  body?: Record<string, unknown>;
  query?: RequestOptions["query"];
  /** Send the dry-run field. Refused unless the route is marked `dryRun: true`. */
  dryRun?: boolean;
  /** Sent as If-Match on update. */
  ifMatch?: string;
}

export interface ResourcesApi {
  /** Every resource name, built in ones first. */
  names(): string[];
  definition(name: string): ResourceDefinition | undefined;
  /** Run one verb of one resource through the client's own transport, so auth, refresh, timeouts and
   *  the contract check apply. A get or an update that answers with an object also carries the
   *  response's `etag`, when the server sends one. */
  call<T = unknown>(name: string, verb: ResourceVerb, opts?: ResourceCallOptions): Promise<T>;
}

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const METHODS: readonly string[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const PATH_CHARS = /^[A-Za-z0-9._~\-/{}]+$/;

// A verb only ever sends the method it is named for, so "list" cannot be a DELETE.
const VERB_METHODS: Record<ResourceVerb, readonly ResourceMethod[]> = {
  list: ["GET"],
  get: ["GET"],
  create: ["POST"],
  update: ["PUT", "PATCH"],
  delete: ["DELETE"],
};
const NEEDS_ID: Record<ResourceVerb, boolean> = { list: false, get: true, create: false, update: true, delete: true };
const TAKES_DRY_RUN: readonly ResourceVerb[] = ["create", "update"];

/** Contents holds only routes the client already calls. `erase` stays its own command, so there is
 *  no delete. */
export const BUILTIN_RESOURCES: readonly ResourceDefinition[] = deepFreeze([
  {
    name: "contents",
    list: { method: "GET", path: "/api/contents" },
    get: { method: "GET", path: "/api/contents/{id}" },
    create: { method: "POST", path: "/api/contents", dryRun: true },
    update: { method: "PUT", path: "/api/contents/{id}", dryRun: true, merge: "data" },
  },
  {
    name: "content-types",
    list: { method: "GET", path: "/api/content-types" },
    get: { method: "GET", path: "/api/contents/types/{id}" },
    create: { method: "POST", path: "/api/content-types" },
  },
] satisfies ResourceDefinition[]);

function deepFreeze<T extends object>(value: T): T {
  for (const v of Object.values(value)) if (typeof v === "object" && v !== null) deepFreeze(v);
  return Object.freeze(value);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Names a key only when it is short and plain, so a file cannot put escape bytes or a huge string
 *  into a message. */
function unknownKey(key: string): string {
  return SAFE_KEY.test(key) ? `unknown key "${key}".` : "an unknown key.";
}

function fail(label: string, message: string): never {
  throw new TypeError(`Invalid resource ${label}: ${message}`);
}

function checkPath(label: string, path: unknown): string {
  if (typeof path !== "string") return fail(label, `"path" must be a string.`);
  if (!path.startsWith("/api/")) return fail(label, `"path" must start with /api/.`);
  for (const bad of ["?", "#", "..", "//", "\\", "%"]) {
    if (path.includes(bad)) return fail(label, `"path" must not contain ${JSON.stringify(bad)}.`);
  }
  if (/\s/.test(path)) return fail(label, `"path" must not contain whitespace.`);
  if (!PATH_CHARS.test(path.slice(1))) {
    return fail(label, `"path" may hold only letters, digits, . _ ~ - / and {id}.`);
  }
  const segments = path.split("/").slice(1);
  for (const seg of segments) {
    if (seg === "." || seg === "") return fail(label, `"path" must not hold an empty or "." segment.`);
    if ((seg.includes("{") || seg.includes("}")) && seg !== "{id}") {
      return fail(label, `"path" may hold no placeholder but {id}, and {id} must be a whole segment.`);
    }
  }
  return path;
}

function checkRoute(name: string, verb: ResourceVerb, route: unknown): ResourceRoute {
  const label = `"${name}" ${verb}`;
  if (!isObject(route)) return fail(label, `the route must be an object.`);
  for (const key of Object.keys(route)) {
    if (key !== "method" && key !== "path" && key !== "dryRun" && key !== "merge") return fail(label, unknownKey(key));
  }
  const method = route.method;
  if (typeof method !== "string" || !METHODS.includes(method)) {
    return fail(label, `"method" must be one of ${METHODS.join(", ")}.`);
  }
  if (!VERB_METHODS[verb].includes(method as ResourceMethod)) {
    return fail(label, `"method" must be ${VERB_METHODS[verb].join(" or ")} for ${verb}.`);
  }
  const path = checkPath(label, route.path);
  const idCount = path.split("/").filter((seg) => seg === "{id}").length;
  if (NEEDS_ID[verb] && idCount !== 1) return fail(label, `"path" must hold {id} exactly once.`);
  if (!NEEDS_ID[verb] && idCount > 0) return fail(label, `"path" must not hold {id}.`);
  const out: ResourceRoute = { method: method as ResourceMethod, path };
  if (route.dryRun !== undefined) {
    if (typeof route.dryRun !== "boolean") return fail(label, `"dryRun" must be true or false.`);
    if (!TAKES_DRY_RUN.includes(verb)) return fail(label, `"dryRun" is allowed on create and update only.`);
    if (route.dryRun) out.dryRun = true;
  }
  if (route.merge !== undefined) {
    if (route.merge !== "data") return fail(label, `"merge" must be "data".`);
    if (verb !== "update") return fail(label, `"merge" is allowed on update only.`);
    out.merge = "data";
  }
  return out;
}

/** Checks one definition, built in or loaded, and returns a frozen copy. Throws a TypeError that
 *  names the resource and the key that failed. */
export function checkResourceDefinition(def: unknown): ResourceDefinition {
  if (!isObject(def)) return fail("definition", "a definition must be an object.");
  const name = def.name;
  if (typeof name !== "string" || !NAME.test(name)) {
    return fail("definition", `"name" must match ${NAME.source}.`);
  }
  const out: Record<string, unknown> = { name };
  for (const key of Object.keys(def)) {
    if (key === "name") continue;
    if (!(RESOURCE_VERBS as readonly string[]).includes(key)) return fail(`"${name}"`, unknownKey(key));
    out[key] = checkRoute(name, key as ResourceVerb, def[key]);
  }
  return deepFreeze(out) as unknown as ResourceDefinition;
}

/** Checks a list of definitions to add to the built in table and returns frozen copies. A name that is
 *  built in, or that appears twice, is refused: a loaded file never replaces a built in resource. */
export function checkResourceDefinitions(defs: unknown): ResourceDefinition[] {
  if (!Array.isArray(defs)) return fail("list", "resources must be an array.");
  const seen = new Set<string>(BUILTIN_RESOURCES.map((d) => d.name));
  return defs.map((raw) => {
    const def = checkResourceDefinition(raw);
    if (seen.has(def.name)) return fail(`"${def.name}"`, `"name" is already taken. Built in resources cannot be replaced.`);
    seen.add(def.name);
    return def;
  });
}

/** The verbs a definition has, in a fixed order. */
export function verbsOf(def: ResourceDefinition): ResourceVerb[] {
  return RESOURCE_VERBS.filter((v) => def[v] !== undefined);
}

/** `METHOD path`, the way a refusal names a route. */
export function routeLabel(route: ResourceRoute): string {
  return `${route.method} ${route.path}`;
}

export function resourcesApi(transport: Transport, extra?: readonly ResourceDefinition[]): ResourcesApi {
  const table = new Map<string, ResourceDefinition>();
  for (const def of BUILTIN_RESOURCES) table.set(def.name, def);
  for (const def of checkResourceDefinitions(extra ?? [])) table.set(def.name, def);

  return {
    names: () => [...table.keys()],
    definition: (name) => table.get(name),
    async call<T>(name: string, verb: ResourceVerb, opts?: ResourceCallOptions): Promise<T> {
      const def = table.get(name);
      if (!def) throw new TypeError(`Invalid resource call: unknown resource. Valid resources: ${[...table.keys()].join(", ")}.`);
      const route = (RESOURCE_VERBS as readonly string[]).includes(verb) ? def[verb] : undefined;
      if (!route) {
        throw new TypeError(
          `Invalid resource call: ${def.name} has no ${String(verb)}. It has: ${verbsOf(def).join(", ")}.`,
        );
      }
      const dryRun = opts?.dryRun === true;
      if (dryRun && route.dryRun !== true) {
        throw new TypeError(`Invalid resource call: ${routeLabel(route)} does not take a dry run.`);
      }
      if (opts?.body !== undefined && !TAKES_DRY_RUN.includes(verb)) {
        throw new TypeError(`Invalid resource call: ${routeLabel(route)} takes no body.`);
      }
      const holdsId = NEEDS_ID[verb];
      if (holdsId && typeof opts?.id !== "string") {
        throw new TypeError(`Invalid resource call: ${routeLabel(route)} needs an id.`);
      }
      if (!holdsId && opts?.id !== undefined) {
        throw new TypeError(`Invalid resource call: ${routeLabel(route)} takes no id.`);
      }
      const path = holdsId ? route.path.replace("{id}", () => pathSegment(opts!.id!)) : route.path;
      const body = dryRun ? { ...(opts?.body ?? {}), dryRun: true } : opts?.body;
      const { body: out, headers } = await transport.requestWithHeaders<T>({
        method: route.method,
        path,
        query: opts?.query,
        body,
        headers: opts?.ifMatch ? { "If-Match": opts.ifMatch } : undefined,
        read: dryRun ? true : undefined, // a dry run saves nothing, so it takes the read timeout
        ...callOpts(opts),
      });
      const etag = headers.get("ETag");
      if (!etag || dryRun || (verb !== "get" && verb !== "update") || !isObject(out)) return out;
      return { ...out, etag } as T;
    },
  };
}
