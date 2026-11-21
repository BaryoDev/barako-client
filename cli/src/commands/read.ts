import { ContentStatus, type Content, type ListContentQuery } from "@baryodev/barako-client";
import { CliError } from "../output";
import { commands, type Command } from "../registry";

const STATUSES: Record<string, ContentStatus> = {
  draft: ContentStatus.Draft,
  published: ContentStatus.Published,
  archived: ContentStatus.Archived,
  scheduled: ContentStatus.Scheduled,
};
export const DEFAULT_LIMIT = 20;
export const ALL_PAGE_SIZE = 100;
export const ALL_CAP = 5000;

function str(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  return typeof v === "string" ? v : undefined;
}

function parseStatus(raw: string | undefined): ContentStatus | undefined {
  if (raw === undefined) return undefined;
  const n = STATUSES[raw];
  if (n === undefined || !Object.prototype.hasOwnProperty.call(STATUSES, raw)) {
    throw new CliError("usage", "--status must be draft, published, archived or scheduled.");
  }
  return n;
}

export function parseLimit(v: unknown): number {
  if (v === undefined) return DEFAULT_LIMIT;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new CliError("usage", "--limit must be a positive whole number.");
  }
  return v;
}

const typesCommand: Command = {
  name: "types",
  summary: "List the content types you can read.",
  args: [],
  async run({ client }) {
    return client.contentTypes.readable();
  },
};

const schemaCommand: Command = {
  name: "schema",
  summary: "Show the fields of one content type.",
  args: [{ name: "type", kind: "positional", type: "string", required: true, description: "Content type name." }],
  async run({ client }, args) {
    return client.contentTypes.get(str(args, "type")!);
  },
};

const listCommand: Command = {
  name: "content list",
  summary: "List entries of a content type.",
  args: [
    { name: "type", kind: "positional", type: "string", required: true, description: "Content type name." },
    { name: "status", kind: "flag", type: "string", description: "draft, published, archived or scheduled." },
    { name: "search", kind: "flag", type: "string", description: "Text to search for in entry values." },
    { name: "limit", kind: "flag", type: "number", description: `Entries per page (default ${DEFAULT_LIMIT}).` },
    { name: "all", kind: "flag", type: "boolean", description: `Follow every page, up to ${ALL_CAP} entries.` },
  ],
  async run({ client }, args) {
    const status = parseStatus(str(args, "status"));
    const limit = parseLimit(args.limit);
    const query: ListContentQuery = { contentType: str(args, "type")! };
    if (status !== undefined) query.status = status;
    const search = str(args, "search");
    if (search !== undefined) query.search = search;

    if (args.all !== true) {
      return client.contents.list({ ...query, pageSize: limit });
    }

    const items: Content[] = [];
    let truncated = false;
    for (let page = 1; ; page++) {
      const res = await client.contents.list({ ...query, page, pageSize: ALL_PAGE_SIZE });
      const got = res?.items ?? [];
      items.push(...got);
      if (items.length >= ALL_CAP) {
        truncated = items.length > ALL_CAP || res?.hasNextPage === true;
        items.length = Math.min(items.length, ALL_CAP);
        break;
      }
      if (!res?.hasNextPage) break;
      if (got.length === 0) {
        // An empty page with more to come means the listing is incomplete.
        truncated = true;
        break;
      }
    }
    return { items, truncated };
  },
};

const getCommand: Command = {
  name: "content get",
  summary: "Show one entry, by id or by --slug type/slug.",
  args: [
    { name: "id", kind: "positional", type: "string", description: "Entry id." },
    { name: "slug", kind: "flag", type: "string", description: "Type and slug as type/slug." },
  ],
  async run({ client }, args) {
    const id = str(args, "id");
    const slug = str(args, "slug");
    if (id !== undefined && slug !== undefined) {
      throw new CliError("usage", "Give an id or --slug, not both.");
    }
    if (id === undefined && slug === undefined) {
      throw new CliError("usage", "Give an id or --slug.");
    }
    let entry: Content & { etag?: string };
    if (slug !== undefined) {
      const i = slug.indexOf("/");
      const type = slug.slice(0, i);
      const rest = slug.slice(i + 1);
      if (i < 1 || rest === "") throw new CliError("usage", "--slug must be type/slug.");
      entry = await client.contents.bySlug(type, rest);
    } else {
      entry = await client.contents.get(id!);
    }
    const { etag: _etag, ...out } = entry;
    return out;
  },
};

const historyCommand: Command = {
  name: "content history",
  summary: "List the saved versions of an entry.",
  args: [{ name: "id", kind: "positional", type: "string", required: true, description: "Entry id." }],
  async run({ client }, args) {
    return client.contents.history(str(args, "id")!);
  },
};

const treeCommand: Command = {
  name: "pages tree",
  summary: "Show the page tree.",
  args: [],
  async run({ client }) {
    return client.pages.tree();
  },
};

commands.push(typesCommand, schemaCommand, listCommand, getCommand, historyCommand, treeCommand);
