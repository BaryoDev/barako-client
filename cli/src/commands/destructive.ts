import { eraseEntry, rollbackEntry } from "../operations";
import { CliError } from "../output";
import { commands, type ArgSpec, type Command } from "../registry";

const CONFIRM: ArgSpec = {
  name: "confirm",
  kind: "flag",
  type: "string",
  description: "Repeat the entry id to confirm. Must equal the id exactly.",
};

/** Stops before any call unless --confirm equals the id. Never echoes either value. `noun` names what
 *  the id belongs to in the messages, such as "entry" or "invoice". */
export function requireConfirm(args: Record<string, unknown>, id: string, noun: string): void {
  const confirm = args.confirm;
  if (typeof confirm !== "string") {
    throw new CliError("usage", `This command is destructive. Pass --confirm with the ${noun} id.`);
  }
  if (confirm !== id) {
    throw new CliError("usage", `--confirm does not match the ${noun} id. Nothing was changed.`);
  }
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
    requireConfirm(args, id, "entry");
    return rollbackEntry(client, id, args.versionId as string);
  },
};

const ENTRY_NOUN = "entry";

const eraseCommand: Command = {
  name: "content erase",
  summary: "Remove an entry and its history for good. Needs the content:destructive scope.",
  args: [
    { name: "id", kind: "positional", type: "string", required: true, description: "Entry id." },
    CONFIRM,
  ],
  async run({ client }, args) {
    const id = args.id as string;
    requireConfirm(args, id, ENTRY_NOUN);
    return eraseEntry(client, id);
  },
};

commands.push(rollbackCommand, eraseCommand);
