import type { BarakoClient, ResourceDefinition } from "@baryodev/barako-client";

export interface ArgSpec {
  name: string;
  kind: "positional" | "flag";
  type: "string" | "boolean" | "number" | "string[]";
  required?: boolean;
  description: string;
}

export interface RunContext {
  client: BarakoClient;
  readFile(path: string): string;
  /** The definitions loaded from --resources or BARAKO_RESOURCES, already checked. */
  fileResources?: ResourceDefinition[];
}

export interface Command {
  name: string;
  summary: string;
  args: ArgSpec[];
  /** True when the command needs no API connection (no URL or key). */
  offline?: boolean;
  /** True when the command reads the resource table, so --resources and BARAKO_RESOURCES apply. */
  usesResources?: boolean;
  run(ctx: RunContext, args: Record<string, unknown>): Promise<unknown>;
}

/** Later tasks append to this table. */
export const commands: Command[] = [];
