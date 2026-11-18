import { CliError, toCliError } from "../output";
import { commands, type ArgSpec, type Command } from "../registry";

const CONFIRM: ArgSpec = {
  name: "confirm",
  kind: "flag",
  type: "string",
  description: "Repeat the entry id to confirm. Must equal the id exactly.",
};

/** Stops before any call unless --confirm equals the id. Never echoes either value. */
function requireConfirm(args: Record<string, unknown>, id: string): void {
  const confirm = args.confirm;
  if (typeof confirm !== "string") {
    throw new CliError("usage", "This command is destructive. Pass --confirm with the entry id.");
  }
  if (confirm !== id) {
    throw new CliError("usage", "--confirm does not match the entry id. Nothing was changed.");
  }
}

/** A 403 means the key lacks the destructive scope. Keep the code and status. */
function scopeError(err: unknown): CliError {
  const base = toCliError(err);
  if (base.status === 403) {
    return new CliError("forbidden", "The API key needs the content:destructive scope for this command.", {
      status: 403,
      details: base.details,
    });
  }
  return base;
}

const rollbackCommand: Command = {
  name: "content rollback",
  summary: "Restore an entry to an earlier version. Needs the content:destructive scope.",
  args: [
    { name: "id", kind: "positional", type: "string", required: true, description: "Entry id." },
    { name: "versionId", kind: "positional", type: "string", required: true, description: "Version id to restore." },
    CONFIRM,
  ],
  async run({ client }, args) {
    const id = args.id as string;
    requireConfirm(args, id);
    try {
      return await client.contents.rollback(id, args.versionId as string);
    } catch (err) {
      throw scopeError(err);
    }
  },
};

const eraseCommand: Command = {
  name: "content erase",
  summary: "Remove an entry and its history for good. Needs the content:destructive scope.",
  args: [
    { name: "id", kind: "positional", type: "string", required: true, description: "Entry id." },
    CONFIRM,
  ],
  async run({ client }, args) {
    const id = args.id as string;
    requireConfirm(args, id);
    try {
      await client.contents.erase(id);
    } catch (err) {
      throw scopeError(err);
    }
    return { erased: id };
  },
};

commands.push(rollbackCommand, eraseCommand);
