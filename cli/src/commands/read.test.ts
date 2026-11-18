import { describe, expect, it, vi } from "vitest";
import type { BarakoClient } from "@baryodev/barako-client";
import { commands, type Command } from "../registry";
import "./read";

function cmd(name: string): Command {
  const c = commands.find((x) => x.name === name);
  if (!c) throw new Error(`missing command ${name}`);
  return c;
}

function fake(parts: Record<string, Record<string, unknown>>) {
  return parts as unknown as BarakoClient;
}

function exec(name: string, client: BarakoClient, args: Record<string, unknown>) {
  return cmd(name).run({ client, readFile: () => "" }, args);
}

async function fails(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await fn();
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected the command to fail");
}

const page = (items: unknown[], hasNextPage: boolean) => ({
  items,
  page: 1,
  pageSize: 100,
  totalItems: 0,
  totalPages: 1,
  hasNextPage,
  hasPreviousPage: false,
});

describe("read commands", () => {
  it("content list maps --status published to 1", async () => {
    const list = vi.fn().mockResolvedValue(page([], false));
    await exec("content list", fake({ contents: { list } }), { type: "post", status: "published" });
    expect(list).toHaveBeenCalledWith({ contentType: "post", status: 1, pageSize: 20 });
  });

  it("content list maps every status name to its number", async () => {
    const list = vi.fn().mockResolvedValue(page([], false));
    const client = fake({ contents: { list } });
    for (const [name, n] of [["draft", 0], ["published", 1], ["archived", 2], ["scheduled", 3]] as const) {
      await exec("content list", client, { type: "post", status: name });
      expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ status: n }));
    }
  });

  it("content list rejects an unknown status as usage without naming the value", async () => {
    const list = vi.fn();
    const err = await fails(() => exec("content list", fake({ contents: { list } }), { type: "post", status: "bogus" }));
    expect(err.code).toBe("usage");
    expect(err.message).not.toContain("bogus");
    expect(list).not.toHaveBeenCalled();
  });

  it("content list rejects inherited names like constructor as a status", async () => {
    const err = await fails(() => exec("content list", fake({ contents: { list: vi.fn() } }), { type: "post", status: "constructor" }));
    expect(err.code).toBe("usage");
  });

  it("content list sets pageSize from --limit and passes --search", async () => {
    const list = vi.fn().mockResolvedValue(page([], false));
    await exec("content list", fake({ contents: { list } }), { type: "post", limit: 5, search: "hi" });
    expect(list).toHaveBeenCalledWith({ contentType: "post", search: "hi", pageSize: 5 });
  });

  it("content list rejects a limit below 1 as usage", async () => {
    const err = await fails(() => exec("content list", fake({ contents: { list: vi.fn() } }), { type: "post", limit: 0 }));
    expect(err.code).toBe("usage");
  });

  it("content list --all follows pages until the last one", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(page([{ id: "a" }, { id: "b" }], true))
      .mockResolvedValueOnce(page([{ id: "c" }], false));
    const res = (await exec("content list", fake({ contents: { list } }), { type: "post", all: true })) as {
      items: unknown[];
      truncated: boolean;
    };
    expect(res.items).toHaveLength(3);
    expect(res.truncated).toBe(false);
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 2 }));
  });

  it("content list --all stops at 5000 entries and sets truncated", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }));
    const list = vi.fn().mockResolvedValue(page(full, true));
    const res = (await exec("content list", fake({ contents: { list } }), { type: "post", all: true })) as {
      items: unknown[];
      truncated: boolean;
    };
    expect(res.items).toHaveLength(5000);
    expect(res.truncated).toBe(true);
    expect(list).toHaveBeenCalledTimes(50);
  });

  it("content get --slug post/hello calls bySlug with the type and slug", async () => {
    const bySlug = vi.fn().mockResolvedValue({ id: "1", version: 2, etag: '"x"' });
    await exec("content get", fake({ contents: { bySlug } }), { slug: "post/hello" });
    expect(bySlug).toHaveBeenCalledWith("post", "hello");
  });

  it("content get rejects a --slug with no slash as usage", async () => {
    const err = await fails(() => exec("content get", fake({ contents: { bySlug: vi.fn() } }), { slug: "post" }));
    expect(err.code).toBe("usage");
  });

  it("content get rejects both an id and --slug as usage", async () => {
    const err = await fails(() => exec("content get", fake({ contents: {} }), { id: "1", slug: "post/hello" }));
    expect(err.code).toBe("usage");
  });

  it("content get rejects neither an id nor --slug as usage", async () => {
    const err = await fails(() => exec("content get", fake({ contents: {} }), {}));
    expect(err.code).toBe("usage");
  });

  it("content get keeps version and leaves out etag", async () => {
    const get = vi.fn().mockResolvedValue({ id: "1", version: 7, data: {}, etag: '"abc"' });
    const res = (await exec("content get", fake({ contents: { get } }), { id: "1" })) as Record<string, unknown>;
    expect(res.version).toBe(7);
    expect("etag" in res).toBe(false);
  });

  it("content history returns the client history for the id", async () => {
    const history = vi.fn().mockResolvedValue([{ version: 1 }]);
    const res = await exec("content history", fake({ contents: { history } }), { id: "9" });
    expect(history).toHaveBeenCalledWith("9");
    expect(res).toEqual([{ version: 1 }]);
  });

  it("schema post returns contentTypes.get as is", async () => {
    const shape = { name: "post", fields: [] };
    const get = vi.fn().mockResolvedValue(shape);
    const res = await exec("schema", fake({ contentTypes: { get } }), { type: "post" });
    expect(get).toHaveBeenCalledWith("post");
    expect(res).toBe(shape);
  });

  it("types returns the readable type names", async () => {
    const readable = vi.fn().mockResolvedValue(["post", "page"]);
    expect(await exec("types", fake({ contentTypes: { readable } }), {})).toEqual(["post", "page"]);
  });

  it("pages tree returns the page tree", async () => {
    const tree = vi.fn().mockResolvedValue({ roots: [] });
    expect(await exec("pages tree", fake({ pages: { tree } }), {})).toEqual({ roots: [] });
  });
});
