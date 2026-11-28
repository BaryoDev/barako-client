// The one CLI module that reads the client's newer exports by name at call time. A client older than
// 0.6.0 lacks them, and a named import of a missing export stops an ES module at load, so every
// command would die. Reading them from the namespace lets the old commands run on 0.5.0 and gives
// the new verbs a clear error.
import * as clientModule from "@baryodev/barako-client";
import type { AddFieldInput, AddFieldResult, BarakoClient, ResourceDefinition, ResourceRoute, ResourceVerb } from "@baryodev/barako-client";
import { CliError } from "./output";

/** The values the CLI reads from the client only when a generic verb runs. */
export interface ResourceKit {
  BUILTIN_RESOURCES: readonly ResourceDefinition[];
  RESOURCE_VERBS: readonly ResourceVerb[];
  routeLabel(route: ResourceRoute): string;
  verbsOf(def: ResourceDefinition): ResourceVerb[];
  checkResourceDefinitions(defs: unknown): ResourceDefinition[];
}

const TOO_OLD = "The generic verbs need @baryodev/barako-client 0.6.0 or later. Update it, then run the command again.";

/** The new client values, or a usage error when the client lacks them. `mod` is injectable for tests. */
export function resourceKit(mod: object = clientModule): ResourceKit {
  const m = mod as Partial<ResourceKit>;
  if (
    typeof m.checkResourceDefinitions !== "function" ||
    typeof m.routeLabel !== "function" ||
    typeof m.verbsOf !== "function" ||
    !Array.isArray(m.BUILTIN_RESOURCES) ||
    !Array.isArray(m.RESOURCE_VERBS)
  ) {
    throw new CliError("usage", TOO_OLD);
  }
  return m as ResourceKit;
}

/** The client's resource table, or a usage error when the client has none. */
export function resourcesOf(client: BarakoClient): BarakoClient["resources"] {
  const table = (client as Partial<BarakoClient>).resources;
  if (typeof table !== "object" || table === null || typeof table.call !== "function") {
    throw new CliError("usage", TOO_OLD);
  }
  return table;
}

const NO_ADD_FIELD = "Adding a field needs @baryodev/barako-client 0.7.0 or later. Update it, then try again.";

/** The client's add-field call, or a usage error when the client has none (before 0.7.0). */
export function addFieldCall(client: BarakoClient): (name: string, field: AddFieldInput) => Promise<AddFieldResult> {
  const types = (client as Partial<BarakoClient>).contentTypes;
  if (typeof types?.addField !== "function") throw new CliError("usage", NO_ADD_FIELD);
  return (name, field) => types.addField(name, field);
}
