import type { BarakoClient } from "@baryodev/barako-client";

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
}

export interface Command {
  name: string;
  summary: string;
  args: ArgSpec[];
  run(ctx: RunContext, args: Record<string, unknown>): Promise<unknown>;
}

/** Later tasks append to this table. */
export const commands: Command[] = [];
