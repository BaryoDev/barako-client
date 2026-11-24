// The four read operations. The CLI commands and the MCP tools both call these, so the two cannot disagree.
import type { BarakoClient, Content, ListContentQuery } from "@baryodev/barako-client";

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

/** The fields of one content type. */
export function getContentType(client: BarakoClient, name: string) {
  return client.contentTypes.get(name);
}

/** One page of entries. Only the fields the caller set are sent. */
export function listEntries(client: BarakoClient, query: ListContentQuery) {
  return client.contents.list(query);
}

/** One entry by id, with the ETag removed. */
export async function getEntry(client: BarakoClient, id: string): Promise<Content> {
  return withoutEtag(await client.contents.get(id));
}
