// The read operations. The CLI commands and the MCP tools both call these, so the two cannot disagree.
import { ContentStatus, type BarakoClient, type Content, type ListContentQuery } from "@baryodev/barako-client";
import type { AddFieldInput, AddFieldResult } from "@baryodev/barako-client";
import { addFieldCall } from "./client-api";
import { dataSchemaOf } from "./data-schema";
import { mergeData } from "./fields";
import { CliError, codeForStatus, toCliError } from "./output";

/** An entry without its ETag. The ETag is a transport detail, not part of the entry. */
export function withoutEtag<T>(entry: T): T {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
  const { etag: _etag, ...rest } = entry as Record<string, unknown>;
  return rest as T;
}

/** The names of the content types the key may read. */
export function listContentTypes(client: BarakoClient) {
  return client.contentTypes.readable();
}

/** The fields of one content type, and `dataSchema`, a JSON Schema for the data of one of its entries. */
export async function getContentType(client: BarakoClient, name: string) {
  const type = await client.contentTypes.get(name);
  return { ...type, dataSchema: dataSchemaOf(type) };
}

/** One page of entries. Only the fields the caller set are sent. */
export function listEntries(client: BarakoClient, query: ListContentQuery) {
  return client.contents.list(query);
}

/** One entry by id, with the ETag removed. */
export async function getEntry(client: BarakoClient, id: string): Promise<Content> {
  return withoutEtag(await client.contents.get(id));
}

// The write operations. The CLI commands and the MCP apply tools call these, so a write sends the same
// request from either side.

/** The server answers with a name such as "Draft". Accept a number too. */
const STATUS_NAMES = ["draft", "published", "archived", "scheduled"];

export function statusName(entry: unknown): string | undefined {
  const s = (entry as { status?: unknown } | undefined)?.status;
  if (typeof s === "string") return s.toLowerCase();
  if (typeof s === "number") return STATUS_NAMES[s];
  return undefined;
}

export function currentVersionOf(entry: unknown): number | undefined {
  const v = (entry as { version?: unknown } | undefined)?.version;
  return typeof v === "number" ? v : undefined;
}

/** Create an entry. It is a draft unless `publish` is true. */
export function createEntry(
  client: BarakoClient,
  input: { contentType: string; data: Record<string, unknown>; publish: boolean },
  opts: { dryRun?: boolean; idempotencyKey?: string },
) {
  const status = input.publish ? ContentStatus.Published : ContentStatus.Draft;
  return client.contents.create({ contentType: input.contentType, data: input.data, status }, opts);
}

/** The error for a failed update. A 409, 412 or 428 re-reads the row with `reread` and reports its
 *  current version beside the server's answer. Anything else keeps the usual mapping. */
export async function updateFailure(err: unknown, reread: () => Promise<unknown>): Promise<CliError> {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 409 || status === 412 || status === 428) {
    let latest: number | undefined;
    try {
      latest = currentVersionOf(await reread());
    } catch {
      // Report the conflict without the version.
    }
    const base = toCliError(err);
    return new CliError(codeForStatus(status), base.message, {
      status,
      details: { currentVersion: latest, server: base.details },
    });
  }
  return toCliError(err);
}

/** The version to send for an entry, from the read that came with it. Version 0 is normal for an entry
 *  with no event stream. The server treats it as "none sent" (Update/Endpoint.cs:259) and checks If-Match
 *  instead (Update/Endpoint.cs:204-221). With no version and no ETag there is nothing to check, so the
 *  write is refused with `noVersion`. */
export function requireVersion(current: unknown, noVersion: string): number {
  const reported = currentVersionOf(current);
  const hasVersion = reported !== undefined && reported >= 1;
  if (!hasVersion && !(current as { etag?: unknown } | undefined)?.etag) {
    throw new CliError("version_required", noVersion);
  }
  return hasVersion ? reported : 0;
}

/** Reads the entry and works out what an update would send: the version, and the data merged with the
 *  patch (or the patch alone with `replace`). `expectVersion` is the CLI's --expect-version. */
export async function prepareUpdate(
  client: BarakoClient,
  id: string,
  patch: Record<string, unknown>,
  opts: { replace: boolean; expectVersion?: unknown; noVersion: string },
) {
  const current = await client.contents.get(id);
  const version = requireVersion(current, opts.noVersion);
  const expected = opts.expectVersion;
  if (typeof expected === "number" && expected !== version) {
    throw new CliError("conflict", `The entry is at version ${version}, not the expected version.`, {
      details: { currentVersion: version },
    });
  }
  const data = opts.replace ? patch : mergeData(current.data ?? {}, patch);
  return { current, data, version };
}

/** Sends the update. A conflict is mapped by updateFailure. */
export async function sendUpdate(
  client: BarakoClient,
  id: string,
  input: { data: Record<string, unknown>; version: number },
  opts: { ifMatch?: string; dryRun?: boolean },
) {
  try {
    return await client.contents.update(id, input, opts);
  } catch (err) {
    throw await updateFailure(err, () => client.contents.get(id));
  }
}

/** Sets the status. A 400 that mentions a lifecycle gets a hint to use a transition. */
export async function setStatus(client: BarakoClient, id: string, to: ContentStatus, toName: string) {
  try {
    const res = await client.contents.setStatus(id, to);
    return { id, status: toName, ...(res?.message === undefined ? {} : { message: res.message }) };
  } catch (err) {
    const e = toCliError(err);
    if (e.status === 400 && /lifecycle|transition/i.test(`${e.message} ${JSON.stringify(e.details ?? "")}`)) {
      throw new CliError(
        "validation",
        `${e.message} If this content type has a lifecycle, use "barako content transition <id> <name>" instead.`,
        { status: 400, details: e.details },
      );
    }
    throw e;
  }
}

/** Only an archived entry can be restored. `from` is the status name now. */
export function requireRestorable(from: string | undefined): void {
  if (from !== "archived") {
    throw new CliError(
      "usage",
      from === "published"
        ? "Only an archived entry can be restored. Use unpublish to make a published entry a draft."
        : "Only an archived entry can be restored.",
    );
  }
}

/** A 403 means the key lacks the destructive scope. Keep the code and status. */
export function scopeError(err: unknown): CliError {
  const base = toCliError(err);
  if (base.status === 403) {
    return new CliError("forbidden", "The API refused this. The key needs the content:destructive scope, and the key's user needs the right to do it.", {
      status: 403,
      details: base.details,
    });
  }
  return base;
}

/** Restore an entry to an earlier version. */
export async function rollbackEntry(client: BarakoClient, id: string, versionId: string) {
  try {
    return await client.contents.rollback(id, versionId);
  } catch (err) {
    throw scopeError(err);
  }
}

/** Remove an entry and its history for good. */
export async function eraseEntry(client: BarakoClient, id: string): Promise<{ erased: string }> {
  try {
    await client.contents.erase(id);
  } catch (err) {
    throw scopeError(err);
  }
  return { erased: id };
}

const FORBIDDEN_FIELD =
  "The API refused this. The key needs the contenttype:write scope, and its user needs the right to change content types. " +
  "If the key has no contenttype:write, create a key with contenttype:read and contenttype:write and use that one. " +
  "A key made by an earlier barako up has only the content scopes, and barako up keeps it.";

/** The words the server gave for a refusal: its message, then the text of each entry in `errors`. */
function serverWords(err: CliError): string {
  const errors = (err.details as { errors?: unknown } | undefined)?.errors;
  const lines: string[] = [];
  if (typeof errors === "object" && errors !== null) {
    for (const v of Object.values(errors)) {
      for (const item of Array.isArray(v) ? v : [v]) if (typeof item === "string" && item !== "") lines.push(item.slice(0, 300));
    }
  }
  return [err.message, ...lines.slice(0, 5)].join(" ");
}

/** Add one field to a content type. A 400, 404 or 409 keeps the server's words. A 403 says which scope
 *  the key needs, followed by the server's own text. */
export async function addField(client: BarakoClient, type: string, input: AddFieldInput): Promise<AddFieldResult | undefined> {
  const call = addFieldCall(client);
  try {
    return await call(type, input);
  } catch (err) {
    const e = toCliError(err);
    if (e.status === 403) {
      throw new CliError("forbidden", `${FORBIDDEN_FIELD} The server said: ${e.message}`, { status: 403, details: e.details });
    }
    if (e.status === 400 || e.status === 404 || e.status === 409) {
      throw new CliError(e.code, serverWords(e), { status: e.status, details: e.details });
    }
    throw e;
  }
}
