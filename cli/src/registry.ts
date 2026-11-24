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
  /** Standard input and output, for a command that serves a stream. Absent in most tests. */
  stdio?: Stdio;
  /** Key values the command must keep out of anything it writes. */
  secrets?: readonly string[];
}

export interface Stdio {
  input: AsyncIterable<string | Uint8Array>;
  /** Writes raw text to stdout. Only protocol output goes here. */
  write(text: string): void;
  /** Writes one line to stderr. */
  log(line: string): void;
  /** Calls back when a write failed later, for example a closed stdout pipe. */
  onWriteError?(cb: () => void): void;
}

export interface Command {
  name: string;
  summary: string;
  args: ArgSpec[];
  /** True when the command needs no API connection (no URL or key). */
  offline?: boolean;
  /** True when the command reads the resource table, so --resources and BARAKO_RESOURCES apply. */
  usesResources?: boolean;
  /** True when the command writes its own output, so the CLI prints nothing on success. */
  silent?: boolean;
  run(ctx: RunContext, args: Record<string, unknown>): Promise<unknown>;
}

/** Later tasks append to this table. */
export const commands: Command[] = [];
