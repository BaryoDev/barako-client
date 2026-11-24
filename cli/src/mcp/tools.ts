import type { BarakoClient, ListContentQuery } from "@baryodev/barako-client";
import { getContentType, getEntry, listContentTypes, listEntries } from "../operations";
import type { Plan, PlanStore } from "./plans";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 1_000_000;
const MAX_NAME_LENGTH = 200;

/** Thrown for arguments that do not fit a tool's schema. The server answers it with a usage tool error. */
export class ArgumentError extends Error {}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint?: boolean; openWorldHint: false };
  /** What to tell the model when the result is over the size cap. A fixed sentence. */
  tooLarge: string;
  /** The id the call aims at, for the log line. Only called after the arguments passed. */
  target?(args: Record<string, unknown>): string | undefined;
  /** Checks the arguments and returns them. Throws ArgumentError. Sends no request. */
  parse(raw: unknown): Record<string, unknown>;
  run(client: BarakoClient, args: Record<string, unknown>, ctx: RunContext): Promise<RunResult>;
}

/** What a call can use besides the client. One per call, over the session's plan store. */
export interface RunContext {
  plans: PlanStore;
  /** An apply sets this once it has found its plan, so the log line names the plan's target. */
  target?: string;
}

export interface RunResult {
  data: unknown;
  /** The id the call acted on, for the log line. Read tools leave it to Tool.target. */
  target?: string;
  /** A plan to keep. The server stores it only after the result passed the size cap. */
  plan?: Plan;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

/** An id or a name that goes into a URL path. The client encodes it too, this is the first check. */
export function checkId(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ArgumentError(`"${label}" must be a string.`);
  if (value.length === 0) throw new ArgumentError(`"${label}" must not be empty.`);
  if (value.length > MAX_NAME_LENGTH) throw new ArgumentError(`"${label}" is longer than ${MAX_NAME_LENGTH} characters.`);
  if (value.includes("/") || value.includes("\\")) throw new ArgumentError(`"${label}" must not hold a slash.`);
  if (value.includes("..")) throw new ArgumentError(`"${label}" must not hold "..".`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    throw new ArgumentError(`"${label}" must not hold control characters.`);
  }
  return value;
}

export function checkInt(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ArgumentError(`"${label}" must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

/** The arguments must be an object that holds only the named keys. */
export function shape(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  const args = raw === undefined || raw === null ? {} : raw;
  if (typeof args !== "object" || Array.isArray(args)) throw new ArgumentError("Arguments must be an object.");
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new ArgumentError("Unknown argument.");
  }
  return args as Record<string, unknown>;
}

/** The fixed tool list. Every string here is written in this file, none comes from the CMS. */
export const TOOLS: readonly Tool[] = [
  {
    name: "list_content_types",
    title: "List content types",
    description: "List the names of the content types this API key may read. Same as `barako types`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
    tooLarge: "This item is over 256 KB and cannot be read through MCP. Use the barako CLI.",
    parse: (raw) => shape(raw, []),
    run: async (client) => ({ data: await listContentTypes(client) }),
  },
  {
    name: "get_content_type",
    title: "Get a content type",
    description: "Show the fields of one content type, by its name. Same as `barako schema <name>`.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The content type name, as returned by list_content_types." } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    tooLarge: "This item is over 256 KB and cannot be read through MCP. Use the barako CLI.",
    target: (a) => a.name as string,
    parse(raw) {
      const a = shape(raw, ["name"]);
      return { name: checkId(a.name, "name") };
    },
    run: async (client, a) => ({ data: await getContentType(client, a.name as string) }),
  },
  {
    name: "list_entries",
    title: "List entries",
    description: `List the entries of one content type, one page at a time. pageSize defaults to ${DEFAULT_PAGE_SIZE} and may be at most ${MAX_PAGE_SIZE}. Same as \`barako content list\`.`,
    inputSchema: {
      type: "object",
      properties: {
        contentType: { type: "string", description: "The content type name, as returned by list_content_types." },
        page: { type: "integer", minimum: 1, description: "Page number, starting at 1. Default 1." },
        pageSize: {
          type: "integer",
          minimum: 1,
          maximum: MAX_PAGE_SIZE,
          description: `Entries per page. Default ${DEFAULT_PAGE_SIZE}, at most ${MAX_PAGE_SIZE}.`,
        },
      },
      required: ["contentType"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    tooLarge: "The page is over 256 KB, so it was not returned. Ask for a smaller pageSize.",
    target: (a) => a.contentType as string,
    parse(raw) {
      const a = shape(raw, ["contentType", "page", "pageSize"]);
      return {
        contentType: checkId(a.contentType, "contentType"),
        // Left out unless given, as the CLI does.
        ...(a.page === undefined ? {} : { page: checkInt(a.page, "page", 1, MAX_PAGE) }),
        pageSize: a.pageSize === undefined ? DEFAULT_PAGE_SIZE : checkInt(a.pageSize, "pageSize", 1, MAX_PAGE_SIZE),
      };
    },
    run: async (client, a) => ({ data: await listEntries(client, a as unknown as ListContentQuery) }),
  },
  {
    name: "get_entry",
    title: "Get an entry",
    description: "Show one entry, by its id. Same as `barako content get <id>`.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The entry id, as returned by list_entries." } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    tooLarge: "This item is over 256 KB and cannot be read through MCP. Use the barako CLI.",
    target: (a) => a.id as string,
    parse(raw) {
      const a = shape(raw, ["id"]);
      return { id: checkId(a.id, "id") };
    },
    run: async (client, a) => ({ data: await getEntry(client, a.id as string) }),
  },
];
