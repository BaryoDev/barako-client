import { describe, expect, it, vi } from "vitest";
import type { BarakoClient } from "@baryodev/barako-client";
import { commands } from "./registry";
import { serve } from "./mcp/server";
import "./commands/read";

function fake() {
  const parts = {
    contentTypes: { readable: vi.fn().mockResolvedValue(["post"]), get: vi.fn().mockResolvedValue({ name: "post", fields: [] }) },
    contents: {
      list: vi.fn().mockResolvedValue({ items: [{ id: "a" }], hasNextPage: false }),
      get: vi.fn().mockResolvedValue({ id: "a", data: { Title: "T" }, etag: "W/1" }),
    },
  };
  return { parts, client: parts as unknown as BarakoClient };
}

async function viaCli(client: BarakoClient, name: string, args: Record<string, unknown>) {
  return commands.find((c) => c.name === name)!.run({ client, readFile: () => "" }, args);
}

async function viaMcp(client: BarakoClient, tool: string, args: Record<string, unknown>) {
  const out: string[] = [];
  async function* input() {
    yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) + "\n";
  }
  await serve({ client, input: input(), writeLine: (t) => out.push(t), log: () => {}, secrets: [] });
  const reply = JSON.parse(out[0]!);
  return JSON.parse(reply.result.content[0].text).data;
}

describe("the CLI and the MCP tools share their operations", () => {
  it("list types: same client call, same result", async () => {
    const a = fake();
    const b = fake();
    const cli = await viaCli(a.client, "types", {});
    const mcp = await viaMcp(b.client, "list_content_types", {});
    expect(a.parts.contentTypes.readable.mock.calls).toEqual(b.parts.contentTypes.readable.mock.calls);
    expect(mcp).toEqual(cli);
  });

  it("get one type: same client call, same result", async () => {
    const a = fake();
    const b = fake();
    const cli = await viaCli(a.client, "schema", { type: "post" });
    const mcp = await viaMcp(b.client, "get_content_type", { name: "post" });
    expect(a.parts.contentTypes.get.mock.calls).toEqual(b.parts.contentTypes.get.mock.calls);
    expect(mcp).toEqual(cli);
  });

  it("list entries: same client call and arguments, no page unless given", async () => {
    const a = fake();
    const b = fake();
    const cli = await viaCli(a.client, "content list", { type: "post", limit: 5 });
    const mcp = await viaMcp(b.client, "list_entries", { contentType: "post", pageSize: 5 });
    expect(a.parts.contents.list.mock.calls).toEqual([[{ contentType: "post", pageSize: 5 }]]);
    expect(b.parts.contents.list.mock.calls).toEqual(a.parts.contents.list.mock.calls);
    expect(mcp).toEqual(cli);
  });

  it("list entries with the default size: same arguments", async () => {
    const a = fake();
    const b = fake();
    await viaCli(a.client, "content list", { type: "post" });
    await viaMcp(b.client, "list_entries", { contentType: "post" });
    expect(b.parts.contents.list.mock.calls).toEqual(a.parts.contents.list.mock.calls);
  });

  it("get one entry: same client call, the etag removed in both", async () => {
    const a = fake();
    const b = fake();
    const cli = await viaCli(a.client, "content get", { id: "a" });
    const mcp = await viaMcp(b.client, "get_entry", { id: "a" });
    expect(a.parts.contents.get.mock.calls).toEqual(b.parts.contents.get.mock.calls);
    expect(cli).not.toHaveProperty("etag");
    expect(mcp).toEqual(cli);
  });
});
