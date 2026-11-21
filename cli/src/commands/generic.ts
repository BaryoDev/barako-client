import type {
  BarakoClient,
  ResourceCallOptions,
  ResourceDefinition,
  ResourceRoute,
  ResourceVerb,
} from "@baryodev/barako-client";
import { resourceKit, resourcesOf } from "../client-api";
import { mergeData } from "../fields";
import { CliError, toCliError } from "../output";
import { commands, type ArgSpec, type Command } from "../registry";
import { requireConfirm } from "./destructive";
import { ALL_CAP, ALL_PAGE_SIZE, parseLimit } from "./read";
import { currentVersionOf, FIELD_ARGS, patchFrom, updateFailure } from "./write";

const RESOURCE: ArgSpec = { name: "resource", kind: "positional", type: "string", required: true, description: "Resource name. Run `resources` to list them." };
const ID: ArgSpec = { name: "id", kind: "positional", type: "string", required: true, description: "Row id." };
const RESOURCES_FILE: ArgSpec = {
  name: "resources",
  kind: "flag",
  type: "string",
  description: "JSON file with more resource definitions. Default is BARAKO_RESOURCES.",
};
const DRY_RUN: ArgSpec = { name: "dry-run", kind: "flag", type: "boolean", description: "Check on the server and save nothing. Only routes marked as taking a dry run." };

function str(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  return typeof v === "string" ? v : undefined;
}

function strings(args: Record<string, unknown>, name: string): string[] {
  const v = args[name];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" ? [v] : [];
}

/** The resource by name, looked up in the client's table. The name is never put into a path. */
function resourceOf(client: BarakoClient, args: Record<string, unknown>): ResourceDefinition {
  resourceKit(); // a client without the resource API stops here, before any request
  const table = resourcesOf(client);
  const def = table.definition(str(args, "resource")!);
  if (!def) {
    throw new CliError("usage", `Unknown resource. Valid resources: ${table.names().join(", ")}.`);
  }
  return def;
}

/** The route for one verb. A verb the resource lacks is refused, never guessed. */
function routeOf(def: ResourceDefinition, verb: ResourceVerb): ResourceRoute {
  const route = def[verb];
  if (!route) {
    throw new CliError("usage", `Resource "${def.name}" has no ${verb}. It has: ${resourceKit().verbsOf(def).join(", ") || "none"}.`);
  }
  return route;
}

/** A dry run is refused before any request unless the route is marked as taking one. */
function checkDryRun(args: Record<string, unknown>, route: ResourceRoute): boolean {
  if (args["dry-run"] !== true) return false;
  if (route.dryRun !== true) {
    throw new CliError("usage", `${resourceKit().routeLabel(route)} does not take a dry run.`);
  }
  return true;
}

/** One verb through the client. A 403 names the route, since the scope depends on the resource. */
async function call<T>(client: BarakoClient, def: ResourceDefinition, verb: ResourceVerb, opts: ResourceCallOptions): Promise<T> {
  try {
    return await resourcesOf(client).call<T>(def.name, verb, opts);
  } catch (err) {
    const base = toCliError(err);
    if (base.status === 403) {
      throw new CliError("forbidden", `The API key may not use ${resourceKit().routeLabel(def[verb]!)}.`, { status: 403, details: base.details });
    }
    throw base;
  }
}

/** A top level dryRun field would reach the server as if --dry-run had been asked for. */
function refuseDryRunField(patch: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(patch, "dryRun")) {
    throw new CliError("usage", "A dryRun field cannot come from --set or --file. Use --dry-run, on a route that takes one.");
  }
}

function parseQuery(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const i = pair.indexOf("=");
    if (i < 1) throw new CliError("usage", "--query needs name=value.");
    const name = pair.slice(0, i);
    if (Object.prototype.hasOwnProperty.call(out, name)) {
      throw new CliError("usage", `--query "${name}" is given more than once.`);
    }
    Object.defineProperty(out, name, { value: pair.slice(i + 1), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

interface PagedShape {
  items: unknown[];
  hasNextPage?: boolean;
}

function isPaged(v: unknown): v is PagedShape {
  return typeof v === "object" && v !== null && Array.isArray((v as { items?: unknown }).items);
}

const resourcesCommand: Command = {
  name: "resources",
  summary: "List the resources the generic verbs reach, with their verbs and where each came from.",
  args: [RESOURCES_FILE],
  offline: true,
  usesResources: true,
  async run({ fileResources }) {
    const { BUILTIN_RESOURCES, RESOURCE_VERBS, routeLabel, verbsOf } = resourceKit();
    const entries = [
      ...BUILTIN_RESOURCES.map((def) => ({ def, source: "built in" })),
      ...(fileResources ?? []).map((def) => ({ def, source: "file" })),
    ];
    return entries.map(({ def, source }) => ({
      name: def.name,
      source,
      verbs: verbsOf(def),
      routes: Object.fromEntries(verbsOf(def).map((v) => [v, routeLabel(def[v]!)])),
      dryRun: RESOURCE_VERBS.filter((v) => def[v]?.dryRun === true),
    }));
  },
};

const getCommand: Command = {
  name: "get",
  summary: "Show one row of a resource.",
  args: [RESOURCE, ID, RESOURCES_FILE],
  usesResources: true,
  async run({ client }, args) {
    const def = resourceOf(client, args);
    routeOf(def, "get");
    const row = await call<unknown>(client, def, "get", { id: str(args, "id")! });
    if (typeof row !== "object" || row === null || Array.isArray(row)) return row;
    const { etag: _etag, ...out } = row as Record<string, unknown>;
    return out;
  },
};

const listCommand: Command = {
  name: "list",
  summary: "List the rows of a resource.",
  args: [
    RESOURCE,
    { name: "query", kind: "flag", type: "string[]", description: "Query parameter as name=value. Repeat for more." },
    { name: "limit", kind: "flag", type: "number", description: "Rows per page, sent as pageSize." },
    { name: "all", kind: "flag", type: "boolean", description: `Follow every page, up to ${ALL_CAP} rows. The response must be paged.` },
    RESOURCES_FILE,
  ],
  usesResources: true,
  async run({ client }, args) {
    const def = resourceOf(client, args);
    routeOf(def, "list");
    const query: Record<string, string | number> = parseQuery(strings(args, "query"));
    const limit = args.limit === undefined ? undefined : parseLimit(args.limit);
    // A route may not take a page size, so none is sent unless asked for. Two sources would clash.
    if (limit !== undefined && Object.prototype.hasOwnProperty.call(query, "pageSize")) {
      throw new CliError("usage", "--limit and --query pageSize both set the page size. Use one.");
    }

    if (args.all !== true) {
      if (limit !== undefined) query.pageSize = limit;
      return call(client, def, "list", { query });
    }
    for (const reserved of ["page", "pageSize"]) {
      if (Object.prototype.hasOwnProperty.call(query, reserved)) {
        throw new CliError("usage", `--all sets ${reserved} itself, so --query cannot.`);
      }
    }
    const items: unknown[] = [];
    let truncated = false;
    for (let page = 1; ; page++) {
      const res = await call<unknown>(client, def, "list", { query: { ...query, page, pageSize: ALL_PAGE_SIZE } });
      if (!isPaged(res)) {
        throw new CliError("usage", `--all needs a paged response with items, and ${def.name} list did not return one.`);
      }
      items.push(...res.items);
      if (items.length >= ALL_CAP) {
        truncated = items.length > ALL_CAP || res.hasNextPage === true;
        items.length = Math.min(items.length, ALL_CAP);
        break;
      }
      const more = typeof res.hasNextPage === "boolean" ? res.hasNextPage : res.items.length === ALL_PAGE_SIZE;
      if (!more) break;
      if (res.items.length === 0) {
        // An empty page with more to come means the listing is incomplete.
        truncated = true;
        break;
      }
    }
    return { items, truncated };
  },
};

const createCommand: Command = {
  name: "create",
  summary: "Create a row. The fields are sent as the request body.",
  args: [RESOURCE, ...FIELD_ARGS, DRY_RUN, RESOURCES_FILE],
  usesResources: true,
  async run({ client, readFile }, args) {
    const def = resourceOf(client, args);
    const route = routeOf(def, "create");
    const dryRun = checkDryRun(args, route);
    const { patch, any } = patchFrom(args, readFile);
    if (!any) throw new CliError("usage", "Nothing to send. Give --set, --set-file or --file.");
    refuseDryRunField(patch);
    return call(client, def, "create", { body: patch, dryRun });
  },
};

const updateCommand: Command = {
  name: "update",
  summary: "Change fields of a row. It reads the row first and sends its version or ETag.",
  args: [
    RESOURCE,
    ID,
    ...FIELD_ARGS,
    { name: "expect-version", kind: "flag", type: "number", description: "Stop with a conflict unless the row is at this version." },
    DRY_RUN,
    RESOURCES_FILE,
  ],
  usesResources: true,
  async run({ client, readFile }, args) {
    const def = resourceOf(client, args);
    const route = routeOf(def, "update");
    // Before any request, so a refused dry run reads nothing.
    const dryRun = checkDryRun(args, route);
    if (!def.get) {
      throw new CliError("usage", `Resource "${def.name}" has no get, so update cannot read the row first. It has: ${resourceKit().verbsOf(def).join(", ")}.`);
    }
    const id = str(args, "id")!;
    const { patch, any } = patchFrom(args, readFile);
    if (!any) throw new CliError("usage", "Nothing to change. Give --set, --set-file or --file.");
    refuseDryRunField(patch);
    const merging = route.merge === "data";
    // The URL names the row. A body id that disagrees would aim the write at another row.
    if (!merging && Object.prototype.hasOwnProperty.call(patch, "id") && String(patch.id) !== id) {
      throw new CliError("usage", `--set id (${String(patch.id)}) does not match the id in the URL (${id}). Nothing was sent.`);
    }

    const current = await call<Record<string, unknown> & { etag?: string }>(client, def, "get", { id });
    const reported = currentVersionOf(current);
    const hasVersion = reported !== undefined && reported >= 1;
    // Version 0 is normal for a row with no event stream. The server then checks If-Match instead.
    if (!hasVersion && !current?.etag) {
      throw new CliError(
        "version_required",
        "The server returned neither a version nor an ETag for this row, so the update was not sent.",
      );
    }
    const version = hasVersion ? reported : 0;
    const expected = args["expect-version"];
    if (typeof expected === "number" && expected !== version) {
      throw new CliError("conflict", `The row is at version ${version}, not the expected version.`, {
        details: { currentVersion: version },
      });
    }

    // A route marked `merge: "data"` keeps its fields under `data` (contents does), so the change
    // is merged into the row's data and fields you do not name keep their values. Any other route
    // gets the named fields as top level fields, whatever the row holds.
    let body: Record<string, unknown>;
    if (merging) {
      const held = current?.data;
      const base = typeof held === "object" && held !== null && !Array.isArray(held) ? (held as Record<string, unknown>) : {};
      body = { id, data: mergeData(base, patch), version };
    } else {
      body = { ...patch, id, version };
    }
    try {
      return await call(client, def, "update", { id, body, dryRun, ...(current?.etag ? { ifMatch: current.etag } : {}) });
    } catch (err) {
      throw await updateFailure(err, () => call(client, def, "get", { id }));
    }
  },
};

const deleteCommand: Command = {
  name: "delete",
  summary: "Delete a row for good. Pass --confirm with the same id.",
  args: [
    RESOURCE,
    ID,
    { name: "confirm", kind: "flag", type: "string", description: "Repeat the row id to confirm. Must equal the id exactly." },
    RESOURCES_FILE,
  ],
  usesResources: true,
  async run({ client }, args) {
    const def = resourceOf(client, args);
    routeOf(def, "delete");
    const id = str(args, "id")!;
    requireConfirm(args, id, def.name);
    await call<unknown>(client, def, "delete", { id });
    return { deleted: id, resource: def.name };
  },
};

commands.push(resourcesCommand, getCommand, listCommand, createCommand, updateCommand, deleteCommand);
