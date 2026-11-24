import { describe, expect, it, vi } from "vitest";
import type { BarakoClient } from "@baryodev/barako-client";
import { commands } from "./registry";
import { serve } from "./mcp/server";
import "./commands/read";
import "./commands/write";
import "./commands/status";
import "./commands/destructive";

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

  it("get one type returns the type and a dataSchema built from its fields, from either side", async () => {
    const type = { name: "post", fields: [{ name: "Title", type: "string", isRequired: true, validationRules: {}, multiple: false }] };
    const a = fake();
    const b = fake();
    a.parts.contentTypes.get.mockResolvedValue(type);
    b.parts.contentTypes.get.mockResolvedValue(type);
    const cli = (await viaCli(a.client, "schema", { type: "post" })) as any;
    const mcp = (await viaMcp(b.client, "get_content_type", { name: "post" })) as any;
    expect(cli).toMatchObject(type);
    expect(cli.dataSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(cli.dataSchema.required).toEqual(["Title"]);
    expect(cli.dataSchema.properties.Title.type).toBe("string");
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

function writable() {
  const parts = {
    contents: {
      get: vi.fn().mockResolvedValue({ id: "a", status: "Draft", version: 3, data: { Title: "T", Body: "B" }, etag: "W/1" }),
      update: vi.fn().mockResolvedValue({ id: "a", version: 4 }),
      setStatus: vi.fn().mockResolvedValue({}),
      erase: vi.fn().mockResolvedValue(undefined),
    },
  };
  return { parts, client: parts as unknown as BarakoClient };
}

/** Plan and apply in one session. The apply line needs the token from the plan reply. */
async function writeViaMcp(client: BarakoClient, planTool: string, planArgs: Record<string, unknown>, applyTool: string) {
  const out: string[] = [];
  const call = (id: number, name: string, args: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n";
  async function* input() {
    yield call(1, planTool, planArgs);
    const plan = JSON.parse(JSON.parse(out[0]!).result.content[0].text).data;
    yield call(2, applyTool, { token: plan.token, action: plan.action, target: plan.target });
  }
  await serve({ client, input: input(), writeLine: (t) => out.push(t), log: () => {}, secrets: [], allowWrites: true, allowDestructive: true });
  expect(JSON.parse(out[1]!).result.isError).toBe(false);
}

describe("the CLI and the MCP write tools send the same write", () => {
  it("update: same arguments to contents.update", async () => {
    const a = writable();
    const b = writable();
    await viaCli(a.client, "content update", { id: "a", set: ["Title=New"] });
    await writeViaMcp(b.client, "plan_update_entry", { id: "a", data: { Title: "New" } }, "apply_plan");
    expect(a.parts.contents.update.mock.calls.at(-1)).toEqual([
      "a",
      { data: { Title: "New", Body: "B" }, version: 3 },
      { ifMatch: "W/1" },
    ]);
    expect(b.parts.contents.update.mock.calls.at(-1)).toEqual(a.parts.contents.update.mock.calls.at(-1));
  });

  it("status change: same arguments to contents.setStatus", async () => {
    const a = writable();
    const b = writable();
    await viaCli(a.client, "content publish", { id: "a" });
    await writeViaMcp(b.client, "plan_change_status", { id: "a", action: "publish" }, "apply_plan");
    expect(a.parts.contents.setStatus.mock.calls.at(-1)).toEqual(["a", "Published"]);
    expect(b.parts.contents.setStatus.mock.calls.at(-1)).toEqual(a.parts.contents.setStatus.mock.calls.at(-1));
  });

  it("erase: same arguments to contents.erase", async () => {
    const a = writable();
    const b = writable();
    await viaCli(a.client, "content erase", { id: "a", confirm: "a" });
    await writeViaMcp(b.client, "plan_erase_entry", { id: "a" }, "apply_destructive_plan");
    expect(a.parts.contents.erase.mock.calls.at(-1)).toEqual(["a"]);
    expect(b.parts.contents.erase.mock.calls.at(-1)).toEqual(a.parts.contents.erase.mock.calls.at(-1));
  });
});
