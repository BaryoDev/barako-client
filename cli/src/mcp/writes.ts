import { randomBytes } from "node:crypto";
import { ContentStatus, type BarakoClient } from "@baryodev/barako-client";
import {
  createEntry,
  currentVersionOf,
  eraseEntry,
  prepareUpdate,
  requireRestorable,
  requireVersion,
  rollbackEntry,
  sendUpdate,
  setStatus,
  statusName,
} from "../operations";
import { CliError } from "../output";
import {
  DESTRUCTIVE_ACTIONS,
  sameFingerprint,
  TOKEN_PATTERN,
  WRITE_ACTIONS,
  type Fingerprint,
  type Plan,
  type PlanAction,
} from "./plans";
import { ArgumentError, checkId, RESULT_CAP_BYTES, shape, TOOLS, type RunContext, type RunResult, type Tool } from "./tools";

const NO_VERSION = "The server returned neither a version nor an ETag for this entry, so no plan was made.";
const CHANGED = "The entry changed since the plan, plan again.";
const NO_PLAN = "There is no such plan. It was used, it expired or the token is wrong. Plan again.";
const MISMATCH = "The action or target does not match the plan. The plan was removed. Plan again.";
const WRONG_TOOL = "This plan is applied by the other apply tool. The plan was removed. Plan again.";
const NOTHING = "Nothing to change. Give at least one field in data.";
const PLAN_TOO_LARGE = "The plan is over 256 KB, so no plan was made. Use the barako CLI.";
const CREATED_NO_ID = "The entry was created. The answer had no id. List the entries before you plan another create.";
const APPLIED_TOO_LARGE = "The change was made. The result is over 256 KB, so it is not shown.";

const PLAN_NOTE = "It changes nothing and returns a one-time token for apply.";

/** Plan tools only read and check. They keep a plan in memory, never in the CMS. */
const PLAN_HINTS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
/** An apply replaces values, so it is destructive. Running it twice is refused, so it is not idempotent. */
const APPLY_HINTS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The data of a create or an update: an object with at least one key. */
function checkData(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ArgumentError('"data" must be an object.');
  if (Object.keys(value).length === 0) throw new ArgumentError(NOTHING);
  return value;
}

/** A plan keeps its data in memory and shows it back, so it must fit the result cap. */
function requireFits(data: unknown): void {
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > RESULT_CAP_BYTES) throw new CliError("usage", PLAN_TOO_LARGE);
}

function checkBool(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ArgumentError(`"${label}" must be true or false.`);
  return value;
}

/** What the entry looked like in this read. The ETag comes from contents.get itself, never from getEntry. */
function fingerprintOf(entry: unknown): Fingerprint {
  const etag = (entry as { etag?: unknown } | undefined)?.etag;
  return { version: currentVersionOf(entry), etag: typeof etag === "string" && etag !== "" ? etag : undefined, status: statusName(entry) };
}

/** A conflict from the server keeps its code and status, with a fixed message. The server's own text
 *  and details are not passed on. */
function plain(err: unknown): unknown {
  if (err instanceof CliError && (err.status === 409 || err.status === 412 || err.status === 428)) {
    return new CliError(err.code, CHANGED, { status: err.status });
  }
  return err;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw plain(err);
  }
}

type Fields<P = Plan> = P extends Plan ? Omit<P, "token" | "expiresAt"> : never;

function planResult(ctx: RunContext, fields: Fields, changes: unknown): RunResult {
  const { token, expiresAt } = ctx.plans.issue();
  const plan = { ...fields, token, expiresAt } as Plan;
  return {
    data: { token, expiresAt: new Date(expiresAt).toISOString(), action: plan.action, target: plan.target, changes },
    target: plan.target,
    plan,
  };
}

function changesOf(res: unknown): unknown {
  return (res as { changes?: unknown } | undefined)?.changes ?? [];
}

const DATA_SCHEMA = {
  type: "object",
  minProperties: 1,
  description: "Field values, as an object of field name to value.",
} as const;

const planCreate: Tool = {
  name: "plan_create_entry",
  title: "Plan a new entry",
  description: `Check a new entry on the server without saving it. ${PLAN_NOTE} Send the token to apply_plan to create it. It is a draft unless publish is true. Same as \`barako content create --dry-run\`.`,
  inputSchema: {
    type: "object",
    properties: {
      contentType: { type: "string", description: "The content type name, as returned by list_content_types." },
      data: DATA_SCHEMA,
      publish: { type: "boolean", description: "Publish the entry on creation. Default false, a draft." },
    },
    required: ["contentType", "data"],
    additionalProperties: false,
  },
  annotations: PLAN_HINTS,
  tooLarge: PLAN_TOO_LARGE,
  target: (a) => a.contentType as string,
  parse(raw) {
    const a = shape(raw, ["contentType", "data", "publish"]);
    return {
      contentType: checkId(a.contentType, "contentType"),
      data: checkData(a.data),
      publish: checkBool(a.publish, "publish") ?? false,
    };
  },
  async run(client, a, ctx) {
    const input = { contentType: a.contentType as string, data: a.data as Record<string, unknown>, publish: a.publish === true };
    requireFits(input.data);
    // No idempotency key on the dry run. The key made here is sent only when the plan is applied.
    const dry = await createEntry(client, input, { dryRun: true });
    return planResult(ctx, { action: "create_entry", target: input.contentType, input, idempotencyKey: randomBytes(16).toString("hex") }, changesOf(dry));
  },
};

const planUpdate: Tool = {
  name: "plan_update_entry",
  title: "Plan a change to an entry",
  description: `Check a change to one entry on the server without saving it. Fields not named in data keep their values, unless replace is true. ${PLAN_NOTE} Send the token to apply_plan to make the change. Same as \`barako content update --dry-run\`.`,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The entry id, as returned by list_entries." },
      data: DATA_SCHEMA,
      replace: { type: "boolean", description: "Send data as the whole entry data, with no merge. Default false." },
    },
    required: ["id", "data"],
    additionalProperties: false,
  },
  annotations: PLAN_HINTS,
  tooLarge: PLAN_TOO_LARGE,
  target: (a) => a.id as string,
  parse(raw) {
    const a = shape(raw, ["id", "data", "replace"]);
    return { id: checkId(a.id, "id"), data: checkData(a.data), replace: checkBool(a.replace, "replace") ?? false };
  },
  async run(client, a, ctx) {
    const id = a.id as string;
    const { current, data, version } = await prepareUpdate(client, id, a.data as Record<string, unknown>, {
      replace: a.replace === true,
      noVersion: NO_VERSION,
    });
    requireFits(data);
    const fingerprint = fingerprintOf(current);
    const dry = await guarded(() =>
      sendUpdate(client, id, { data, version }, { ...(fingerprint.etag ? { ifMatch: fingerprint.etag } : {}), dryRun: true }),
    );
    return planResult(ctx, { action: "update_entry", target: id, data, version, fingerprint }, changesOf(dry));
  },
};

const STATUS_ACTIONS = ["publish", "unpublish", "archive", "restore"] as const;
const STATUS_TARGET = { publish: "published", unpublish: "draft", archive: "archived", restore: "draft" } as const;
const STATUS_ENUM = { published: ContentStatus.Published, draft: ContentStatus.Draft, archived: ContentStatus.Archived } as const;

const planStatus: Tool = {
  name: "plan_change_status",
  title: "Plan a status change",
  description: `Check a status change of one entry: publish, unpublish, archive or restore. Restore works only on an archived entry. ${PLAN_NOTE} Send the token to apply_plan to make the change. Same as \`barako content publish\` and the like.`,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The entry id, as returned by list_entries." },
      action: { type: "string", enum: [...STATUS_ACTIONS], description: "What to do with the entry." },
    },
    required: ["id", "action"],
    additionalProperties: false,
  },
  annotations: PLAN_HINTS,
  tooLarge: PLAN_TOO_LARGE,
  target: (a) => a.id as string,
  parse(raw) {
    const a = shape(raw, ["id", "action"]);
    if (!(STATUS_ACTIONS as readonly unknown[]).includes(a.action)) {
      throw new ArgumentError('"action" must be publish, unpublish, archive or restore.');
    }
    return { id: checkId(a.id, "id"), action: a.action };
  },
  async run(client, a, ctx) {
    const id = a.id as string;
    const move = a.action as (typeof STATUS_ACTIONS)[number];
    const entry = await client.contents.get(id);
    requireVersion(entry, NO_VERSION);
    const from = statusName(entry);
    if (move === "restore") requireRestorable(from);
    const to = STATUS_TARGET[move];
    return planResult(ctx, { action: "change_status", target: id, to, fingerprint: fingerprintOf(entry) }, { from: from ?? null, to });
  },
};

function entryFacts(entry: unknown) {
  return {
    contentType: (entry as { contentType?: unknown } | undefined)?.contentType ?? null,
    status: statusName(entry) ?? null,
    currentVersion: currentVersionOf(entry) ?? null,
  };
}

const planRollback: Tool = {
  name: "plan_rollback_entry",
  title: "Plan a rollback",
  description: `Check a rollback of one entry to an earlier version. The rollback replaces the entry's current values. ${PLAN_NOTE} Send the token to apply_destructive_plan. Same as \`barako content rollback\`.`,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The entry id, as returned by list_entries." },
      versionId: { type: "string", description: "The id of the version to restore." },
    },
    required: ["id", "versionId"],
    additionalProperties: false,
  },
  annotations: PLAN_HINTS,
  tooLarge: PLAN_TOO_LARGE,
  target: (a) => a.id as string,
  parse(raw) {
    const a = shape(raw, ["id", "versionId"]);
    return { id: checkId(a.id, "id"), versionId: checkId(a.versionId, "versionId") };
  },
  async run(client, a, ctx) {
    const id = a.id as string;
    const versionId = a.versionId as string;
    const entry = await client.contents.get(id);
    requireVersion(entry, NO_VERSION);
    // The version id is passed on unchecked. A wrong one is the server's 404 at apply.
    return planResult(ctx, { action: "rollback_entry", target: id, versionId, fingerprint: fingerprintOf(entry) }, { ...entryFacts(entry), versionId });
  },
};

const planErase: Tool = {
  name: "plan_erase_entry",
  title: "Plan an erase",
  description: `Check the erase of one entry and its history. An erase cannot be undone. ${PLAN_NOTE} Send the token to apply_destructive_plan. Same as \`barako content erase\`.`,
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "The entry id, as returned by list_entries." } },
    required: ["id"],
    additionalProperties: false,
  },
  annotations: PLAN_HINTS,
  tooLarge: PLAN_TOO_LARGE,
  target: (a) => a.id as string,
  parse(raw) {
    const a = shape(raw, ["id"]);
    return { id: checkId(a.id, "id") };
  },
  async run(client, a, ctx) {
    const id = a.id as string;
    const entry = await client.contents.get(id);
    requireVersion(entry, NO_VERSION);
    return planResult(ctx, { action: "erase_entry", target: id, fingerprint: fingerprintOf(entry) }, entryFacts(entry));
  },
};

/** Reads the entry again and refuses unless it is as it was at plan time. */
async function reread(client: BarakoClient, id: string, planned: Fingerprint) {
  const now = await client.contents.get(id);
  if (!sameFingerprint(planned, fingerprintOf(now))) throw new CliError("conflict", CHANGED);
}

/** Sends exactly what the plan holds.
 *
 *  Only an update carries If-Match, so only an update is safe against a write that lands between the
 *  re-read and the write. For a status change, a rollback and an erase the re-read is the whole check. */
async function execute(client: BarakoClient, plan: Plan): Promise<unknown> {
  switch (plan.action) {
    case "create_entry": {
      const res = (await createEntry(client, plan.input, { idempotencyKey: plan.idempotencyKey })) as { id?: unknown; version?: unknown } | undefined;
      // The entry exists by now, so a thin answer must not turn into an error.
      if (typeof res?.id !== "string") return { created: true, note: CREATED_NO_ID };
      return { id: res.id, version: res.version };
    }
    case "update_entry": {
      await reread(client, plan.target, plan.fingerprint);
      const etag = plan.fingerprint.etag;
      const res = await guarded(() =>
        sendUpdate(client, plan.target, { data: plan.data, version: plan.version }, etag ? { ifMatch: etag } : {}),
      );
      return { id: plan.target, version: (res as { version?: number } | undefined)?.version };
    }
    case "change_status": {
      await reread(client, plan.target, plan.fingerprint);
      const res = await setStatus(client, plan.target, STATUS_ENUM[plan.to], plan.to);
      return { id: res.id, status: res.status };
    }
    case "rollback_entry": {
      await reread(client, plan.target, plan.fingerprint);
      const res = (await rollbackEntry(client, plan.target, plan.versionId)) as unknown as { id?: string; version?: unknown } | undefined;
      // The server's answer holds the whole entry. Only the id and a version, if it sends one, are kept.
      return { id: res?.id ?? plan.target, ...(typeof res?.version === "number" ? { version: res.version } : {}) };
    }
    case "erase_entry": {
      await reread(client, plan.target, plan.fingerprint);
      return eraseEntry(client, plan.target);
    }
  }
}

function applyTool(name: string, title: string, description: string, destructive: boolean, listed: readonly PlanAction[]): Tool {
  return {
    name,
    title,
    description,
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "The one-time token from the plan." },
        action: { type: "string", enum: [...listed], description: "The action the plan returned." },
        target: { type: "string", description: "The target the plan returned: an entry id, or the content type name for a create." },
      },
      required: ["token", "action", "target"],
      additionalProperties: false,
    },
    annotations: APPLY_HINTS,
    tooLarge: APPLIED_TOO_LARGE,
    parse(raw) {
      const a = shape(raw, ["token", "action", "target"]);
      if (typeof a.token !== "string" || !TOKEN_PATTERN.test(a.token)) {
        throw new ArgumentError('"token" must be the token the plan returned.');
      }
      // A wrong action is refused here, before the plan is looked up, so the plan survives.
      if (!(listed as readonly unknown[]).includes(a.action)) {
        throw new ArgumentError(
          '"action" is not one this tool applies. Rollback and erase go to apply_destructive_plan, the others to apply_plan.',
        );
      }
      return { token: a.token, action: a.action, target: checkId(a.target, "target") };
    },
    async run(client, a, ctx) {
      // Finding the plan removes it. Whatever happens next, the token is spent.
      const plan = ctx.plans.take(a.token as string);
      if (!plan) throw new CliError("usage", NO_PLAN);
      ctx.target = plan.target;
      if ((DESTRUCTIVE_ACTIONS as readonly PlanAction[]).includes(plan.action) !== destructive) throw new CliError("usage", WRONG_TOOL);
      if (plan.action !== a.action || plan.target !== a.target) throw new CliError("usage", MISMATCH);
      return { data: await execute(client, plan), target: plan.target };
    },
  };
}

const applyPlan = applyTool(
  "apply_plan",
  "Apply a plan",
  "Make the change of a plan from plan_create_entry, plan_update_entry or plan_change_status. Needs the plan's token, action and target. A token works once and expires after 10 minutes. If a create fails with a network error, list the entries before you plan it again.",
  false,
  WRITE_ACTIONS,
);

const applyDestructive = applyTool(
  "apply_destructive_plan",
  "Apply a destructive plan",
  "Make the change of a plan from plan_rollback_entry or plan_erase_entry. Needs the plan's token, action and target. The API refuses it unless the key has the content:destructive scope and the key's user has the right to do it. A token works once and expires after 10 minutes.",
  true,
  DESTRUCTIVE_ACTIONS,
);

export interface ToolMode {
  writes: boolean;
  destructive: boolean;
}

/** Tools every session lists when writes are on. */
const WRITE_TOOLS: readonly Tool[] = [planCreate, planUpdate, planStatus, applyPlan];
/** Tools that also need --allow-destructive. */
const DESTRUCTIVE_TOOLS: readonly Tool[] = [planRollback, planErase, applyDestructive];

/** The tools to list for a mode. A tool left out is an unknown tool, so a call to it sends no request. */
export function toolsFor(mode: ToolMode): readonly Tool[] {
  if (!mode.writes) return TOOLS;
  return [...TOOLS, ...WRITE_TOOLS, ...(mode.destructive ? DESTRUCTIVE_TOOLS : [])];
}
