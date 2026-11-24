import { ContentStatus } from "@baryodev/barako-client";
import { parseSets } from "../fields";
import { requireRestorable, setStatus, statusName } from "../operations";
import { CliError } from "../output";
import { commands, type Command } from "../registry";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function parseIso(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !ISO.test(v) || Number.isNaN(Date.parse(v))) {
    throw new CliError("usage", `--${name} must be an ISO 8601 date and time with Z or an offset.`);
  }
  return v;
}

const ID_ARG = { name: "id", kind: "positional", type: "string", required: true, description: "Entry id." } as const;
const DRY_ARG = {
  name: "dry-run",
  kind: "flag",
  type: "boolean",
  description: "Check the change on the client and write nothing.",
} as const;

function move(name: string, summary: string, to: ContentStatus, toName: string): Command {
  return {
    name: `content ${name}`,
    summary,
    args: [ID_ARG, DRY_ARG],
    async run({ client }, args) {
      const id = args.id as string;
      if (args["dry-run"] === true) {
        const entry = await client.contents.get(id);
        return { dryRun: true, checkedBy: "client", from: statusName(entry) ?? null, to: toName };
      }
      return setStatus(client, id, to, toName);
    },
  };
}

const restoreCommand: Command = {
  name: "content restore",
  summary: "Bring an archived entry back as a draft.",
  args: [ID_ARG, DRY_ARG],
  async run({ client }, args) {
    const id = args.id as string;
    const entry = await client.contents.get(id);
    const from = statusName(entry);
    requireRestorable(from);
    if (args["dry-run"] === true) return { dryRun: true, checkedBy: "client", from, to: "draft" };
    return setStatus(client, id, ContentStatus.Draft, "draft");
  },
};

const transitionCommand: Command = {
  name: "content transition",
  summary: "Run a named lifecycle transition on an entry.",
  args: [
    ID_ARG,
    { name: "name", kind: "positional", type: "string", required: true, description: "Transition name." },
    { name: "set", kind: "flag", type: "string[]", description: "Transition field as Name=value, or Name:=json." },
    { name: "set-file", kind: "flag", type: "string[]", description: "Transition field read from a file, as Name=path." },
  ],
  async run({ client, readFile }, args) {
    const sets = Array.isArray(args.set) ? (args.set as string[]) : [];
    const setFiles = Array.isArray(args["set-file"]) ? (args["set-file"] as string[]) : [];
    const data = parseSets(sets, setFiles, readFile);
    const hasData = sets.length > 0 || setFiles.length > 0;
    const res = await client.contents.transition(args.id as string, args.name as string, hasData ? data : undefined);
    return { id: args.id, transition: args.name, ...(res?.message === undefined ? {} : { message: res.message }) };
  },
};

const scheduleCommand: Command = {
  name: "content schedule",
  summary:
    "Schedule publishing. Both times are sent on every call, so leaving out --unpublish-at clears any unpublish time.",
  args: [
    ID_ARG,
    { name: "publish-at", kind: "flag", type: "string", required: true, description: "When to publish, ISO 8601 with Z or an offset." },
    {
      name: "unpublish-at",
      kind: "flag",
      type: "string",
      description: "When to unpublish, ISO 8601 with Z or an offset. If absent, the unpublish time is cleared.",
    },
  ],
  async run({ client }, args) {
    const publishAt = parseIso(args, "publish-at")!;
    const unpublishAt = parseIso(args, "unpublish-at") ?? null;
    const id = args.id as string;
    const current = await client.contents.get(id);
    const v = (current as { version?: unknown }).version;
    // Version 0 means none sent to the server (Schedule/Endpoint.cs:87). The schedule route reads no
    // If-Match, so an entry with no event stream is scheduled last write wins. The ETag check only
    // confirms the entry is a normal one with no event stream.
    if (!(typeof v === "number" && v > 0) && !(current as { etag?: unknown }).etag) {
      throw new CliError("version_required", "The server returned neither a version nor an ETag for this entry, so the schedule was not sent.");
    }
    const at: { publishAt: string | null; unpublishAt: string | null; version?: number } = { publishAt, unpublishAt };
    if (typeof v === "number" && v > 0) at.version = v;
    return client.contents.schedule(id, at);
  },
};

commands.push(
  move("publish", "Publish an entry.", ContentStatus.Published, "published"),
  move("unpublish", "Make a published entry a draft.", ContentStatus.Draft, "draft"),
  move("archive", "Archive an entry.", ContentStatus.Archived, "archived"),
  restoreCommand,
  transitionCommand,
  scheduleCommand,
);
