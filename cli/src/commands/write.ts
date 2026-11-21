import { ContentStatus } from "@baryodev/barako-client";
import { mergeData, parseSets, readDataFile } from "../fields";
import { CliError, codeForStatus, toCliError } from "../output";
import { commands, type ArgSpec, type Command } from "../registry";

function str(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  return typeof v === "string" ? v : undefined;
}

function list(args: Record<string, unknown>, name: string): string[] {
  const v = args[name];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" ? [v] : [];
}

export const FIELD_ARGS: ArgSpec[] = [
  { name: "set", kind: "flag", type: "string[]", description: "Field value as Name=value, or Name:=json. Repeat for more fields." },
  { name: "set-file", kind: "flag", type: "string[]", description: "Field value read from a file, as Name=path. Repeat for more fields." },
  { name: "file", kind: "flag", type: "string", description: "A JSON file holding the fields." },
];

/** Field values from --file, --set and --set-file. --set and --set-file win over --file. */
export function patchFrom(
  args: Record<string, unknown>,
  readFile: (p: string) => string,
): { patch: Record<string, unknown>; any: boolean } {
  const sets = list(args, "set");
  const setFiles = list(args, "set-file");
  const file = str(args, "file");
  const fromFile = file === undefined ? {} : readDataFile(file, readFile);
  const fromSets = parseSets(sets, setFiles, readFile);
  return {
    patch: mergeData(fromFile, fromSets),
    any: file !== undefined || sets.length > 0 || setFiles.length > 0,
  };
}

const createCommand: Command = {
  name: "content create",
  summary: "Create an entry. It is a draft unless you pass --publish.",
  args: [
    { name: "type", kind: "positional", type: "string", required: true, description: "Content type name." },
    ...FIELD_ARGS,
    { name: "publish", kind: "flag", type: "boolean", description: "Publish the entry on creation." },
    { name: "idempotency-key", kind: "flag", type: "string", description: "Key that makes a retried create safe." },
    { name: "dry-run", kind: "flag", type: "boolean", description: "Check the entry and show the changes without saving." },
  ],
  async run({ client, readFile }, args) {
    const { patch } = patchFrom(args, readFile);
    const status = args.publish === true ? ContentStatus.Published : ContentStatus.Draft;
    const opts: { dryRun?: boolean; idempotencyKey?: string } = {};
    if (args["dry-run"] === true) opts.dryRun = true;
    const key = str(args, "idempotency-key");
    if (key !== undefined) opts.idempotencyKey = key;
    return client.contents.create({ contentType: str(args, "type")!, data: patch, status }, opts);
  },
};

export function currentVersionOf(entry: unknown): number | undefined {
  const v = (entry as { version?: unknown } | undefined)?.version;
  return typeof v === "number" ? v : undefined;
}

const updateCommand: Command = {
  name: "content update",
  summary: "Change fields of an entry. Fields you do not name keep their values.",
  args: [
    { name: "id", kind: "positional", type: "string", required: true, description: "Entry id." },
    ...FIELD_ARGS,
    { name: "replace", kind: "flag", type: "boolean", description: "Send --file as the whole data, with no merge." },
    { name: "expect-version", kind: "flag", type: "number", description: "Stop with a conflict unless the entry is at this version." },
    { name: "dry-run", kind: "flag", type: "boolean", description: "Check the change and show it without saving." },
  ],
  async run({ client, readFile }, args) {
    const id = str(args, "id")!;
    const replace = args.replace === true;
    if (replace && str(args, "file") === undefined) {
      throw new CliError("usage", "--replace needs --file.");
    }
    const { patch, any } = patchFrom(args, readFile);
    if (!any) throw new CliError("usage", "Nothing to change. Give --set, --set-file or --file.");

    const current = await client.contents.get(id);
    const reported = currentVersionOf(current);
    const hasVersion = reported !== undefined && reported >= 1;
    // Version 0 is normal for an entry with no event stream. The server treats it as "none sent"
    // (Update/Endpoint.cs:259) and checks If-Match instead (Update/Endpoint.cs:204-221).
    if (!hasVersion && !current.etag) {
      throw new CliError(
        "version_required",
        "The server returned neither a version nor an ETag for this entry, so the update was not sent.",
      );
    }
    const version = hasVersion ? reported : 0;
    const expected = args["expect-version"];
    if (typeof expected === "number" && expected !== version) {
      throw new CliError("conflict", `The entry is at version ${version}, not the expected version.`, {
        details: { currentVersion: version },
      });
    }

    const data = replace ? patch : mergeData(current.data ?? {}, patch);
    const opts: { ifMatch?: string; dryRun?: boolean } = {};
    if (current.etag) opts.ifMatch = current.etag;
    if (args["dry-run"] === true) opts.dryRun = true;

    try {
      return await client.contents.update(id, { data, version }, opts);
    } catch (err) {
      const status = (err as { status?: unknown } | null)?.status;
      if (status === 409 || status === 412 || status === 428) {
        let latest: number | undefined;
        try {
          latest = currentVersionOf(await client.contents.get(id));
        } catch {
          // Report the conflict without the version.
        }
        const base = toCliError(err);
        throw new CliError(codeForStatus(status), base.message, {
          status,
          details: { currentVersion: latest, server: base.details },
        });
      }
      throw toCliError(err);
    }
  },
};

commands.push(createCommand, updateCommand);
