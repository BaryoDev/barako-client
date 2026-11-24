import { describe, expect, it, vi } from "vitest";
import { BarakoError, type BarakoClient } from "@baryodev/barako-client";
import { run } from "../main";
import { RESULT_CAP_BYTES, serve } from "./server";
import { MAX_PLANS, PLAN_TTL_MS, PlanStore, type Plan } from "./plans";

const KEY = "bcms_secretkey_0123456789";
const START = Date.parse("2026-11-24T10:00:00.000Z");

type Json = Record<string, any>;
type Step = (replies: Json[]) => string | Json;

const ENTRY = { id: "a", contentType: "post", status: "Draft", version: 3, data: { Title: "Old", Body: "B" }, etag: '"e1"' };

function writer(over: Record<string, unknown> = {}) {
  const contents = {
    get: vi.fn().mockResolvedValue({ ...ENTRY }),
    create: vi
      .fn()
      .mockImplementation(async (_input: unknown, opts?: { dryRun?: boolean }) =>
        opts?.dryRun ? { dryRun: true, changes: [{ field: "Title", to: "New" }] } : { id: "n1", version: 1 },
      ),
    update: vi
      .fn()
      .mockImplementation(async (_id: string, _input: unknown, opts?: { dryRun?: boolean }) =>
        opts?.dryRun ? { dryRun: true, changes: [{ field: "Title", to: "New" }] } : { id: "a", version: 4 },
      ),
    setStatus: vi.fn().mockResolvedValue({ message: "done" }),
    rollback: vi.fn().mockResolvedValue({ id: "a", contentType: "post", data: { Title: "Old" } }),
    erase: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
  return { client: { contents } as unknown as BarakoClient, contents };
}

const call = (id: number, name: string, args?: unknown): Json => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, ...(args === undefined ? {} : { arguments: args }) },
});

interface Opts {
  client?: BarakoClient;
  destructive?: boolean;
  writes?: boolean;
  now?: () => Date;
}

/** Sends one line at a time. A step sees every reply so far, so an apply can use the token of its plan. */
async function converse(steps: Step[], opts: Opts = {}) {
  const out: string[] = [];
  const log: string[] = [];
  async function* input() {
    for (let i = 0; i < steps.length; i++) {
      const line = steps[i]!(out.map((l) => JSON.parse(l) as Json));
      yield (typeof line === "string" ? line : JSON.stringify(line)) + "\n";
    }
  }
  await serve({
    client: opts.client ?? writer().client,
    input: input(),
    writeLine: (t) => out.push(t),
    log: (l) => log.push(l),
    secrets: [KEY],
    now: opts.now ?? (() => new Date(START)),
    allowWrites: opts.writes ?? true,
    allowDestructive: opts.destructive ?? false,
  });
  return { out, log, replies: out.map((l) => JSON.parse(l) as Json) };
}

const body = (reply: Json) => JSON.parse(reply.result.content[0].text);
const dataOf = (reply: Json) => body(reply).data;
const tokenOf = (reply: Json): string => dataOf(reply).token;
const errorOf = (reply: Json) => dataOf(reply).error;

const apply = (id: number, planIndex: number, tool = "apply_plan", over: Json = {}): Step => (r) => {
  const d = dataOf(r[planIndex]!);
  return call(id, tool, { token: d.token, action: d.action, target: d.target, ...over });
};

describe("mcp write tools: listing", () => {
  it("write tool is absent without --allow-writes", async () => {
    const { client, contents } = writer();
    const { replies } = await converse(
      [() => ({ jsonrpc: "2.0", id: 1, method: "tools/list" }), () => call(2, "plan_create_entry", { contentType: "post", data: { A: 1 } })],
      { client, writes: false },
    );
    const names = (replies[0]!.result.tools as Json[]).map((t) => t.name);
    expect(names).toEqual(["list_content_types", "get_content_type", "list_entries", "get_entry"]);
    expect(replies[1]!.error.code).toBe(-32602);
    expect(contents.create).not.toHaveBeenCalled();
  });

  it("destructive tools are absent without --allow-destructive", async () => {
    const { client, contents } = writer();
    const { replies } = await converse(
      [() => ({ jsonrpc: "2.0", id: 1, method: "tools/list" }), () => call(2, "plan_erase_entry", { id: "a" }), () => call(3, "apply_destructive_plan", { token: "x", action: "erase_entry", target: "a" })],
      { client },
    );
    const names = (replies[0]!.result.tools as Json[]).map((t) => t.name);
    expect(names).toContain("plan_create_entry");
    expect(names).toContain("apply_plan");
    expect(names).not.toContain("plan_erase_entry");
    expect(names).not.toContain("plan_rollback_entry");
    expect(names).not.toContain("apply_destructive_plan");
    expect(replies[1]!.error.code).toBe(-32602);
    expect(replies[2]!.error.code).toBe(-32602);
    expect(contents.get).not.toHaveBeenCalled();
  });

  it("lists every tool with the fixed hints when both flags are on", async () => {
    const { replies } = await converse([() => ({ jsonrpc: "2.0", id: 1, method: "tools/list" })], { destructive: true });
    const tools = replies[0]!.result.tools as Json[];
    expect(tools.map((t) => t.name)).toEqual([
      "list_content_types", "get_content_type", "list_entries", "get_entry",
      "plan_create_entry", "plan_update_entry", "plan_change_status", "apply_plan",
      "plan_rollback_entry", "plan_erase_entry", "apply_destructive_plan",
    ]);
    for (const t of tools) {
      expect(t.annotations.openWorldHint).toBe(false);
      if (t.name.startsWith("plan_")) expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      if (t.name.startsWith("apply_")) {
        expect(t.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
      }
    }
  });

  it("--allow-destructive without --allow-writes serves nothing", async () => {
    const out: { stream: string; text: string }[] = [];
    let touched = false;
    async function* stdin() {
      touched = true;
      yield '{"jsonrpc":"2.0","id":1,"method":"ping"}\n';
    }
    const code = await run(["mcp", "--allow-destructive"], { BARAKO_URL: "https://cms.example.com", BARAKO_API_KEY: KEY }, {
      readFile: () => "",
      write: (stream, text) => out.push({ stream, text }),
      stdin: stdin(),
    });
    expect(code).toBe(1);
    expect(touched).toBe(false);
    expect(out.filter((o) => o.stream === "stdout")).toEqual([]);
    const text = out.map((o) => o.text).join("");
    expect(text).toContain("--allow-destructive needs --allow-writes");
    expect(text).not.toContain("barako mcp:");
  });
});

describe("mcp write tools: plan and apply", () => {
  it("apply without a plan token is refused", async () => {
    const { client, contents } = writer();
    const { replies, log } = await converse(
      [
        () => call(1, "apply_plan", { action: "update_entry", target: "a" }),
        () => call(2, "apply_plan", { token: "", action: "update_entry", target: "a" }),
        () => call(3, "apply_plan", { token: "bad token!", action: "update_entry", target: "a" }),
        () => call(4, "apply_plan", { token: "A".repeat(65), action: "update_entry", target: "a" }),
        () => call(5, "apply_plan", { token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", action: "update_entry", target: "a" }),
      ],
      { client },
    );
    for (const r of replies) {
      expect(r.result.isError).toBe(true);
      expect(errorOf(r).code).toBe("usage");
    }
    expect(log[4]).toBe('2026-11-24T10:00:00.000Z tool="apply_plan" target=- status=error:usage:0');
    for (const fn of Object.values(contents)) expect(fn).not.toHaveBeenCalled();
  });

  it("plan token is refused after the target changed", async () => {
    const changes: Record<string, unknown>[] = [{ version: 4 }, { etag: '"e2"' }, { status: "Published" }, { etag: undefined }, { version: undefined }];
    for (const change of changes) {
      const { client, contents } = writer();
      const s = await converse(
        [
          () => call(1, "plan_update_entry", { id: "a", data: { Title: "New" } }),
          () => {
            contents.get.mockResolvedValue({ ...ENTRY, ...change });
            return call(2, "noop");
          },
          apply(3, 0),
        ],
        { client },
      );
      expect(s.replies[2]!.result.isError).toBe(true);
      expect(errorOf(s.replies[2]!).message).toContain("changed since the plan");
      // Only the dry run was sent.
      expect(contents.update).toHaveBeenCalledTimes(1);
      expect(contents.update.mock.calls[0]![2]).toMatchObject({ dryRun: true });
    }
  });

  it("refuses an apply whose action or target differs from the plan, and removes the plan", async () => {
    const { client, contents } = writer();
    const s = await converse(
      [
        () => call(1, "plan_update_entry", { id: "a", data: { Title: "New" } }),
        apply(2, 0, "apply_plan", { target: "b" }),
        apply(3, 0),
        () => call(4, "plan_update_entry", { id: "a", data: { Title: "New" } }),
        apply(5, 3, "apply_plan", { action: "change_status" }),
      ],
      { client },
    );
    expect(errorOf(s.replies[1]!).message).toContain("does not match the plan");
    // The first apply removed the plan, so the right one is refused too.
    expect(errorOf(s.replies[2]!).message).toContain("no such plan");
    expect(errorOf(s.replies[4]!).message).toContain("does not match the plan");
    expect(contents.update).toHaveBeenCalledTimes(2);
  });

  it("a plan token works once", async () => {
    const { client, contents } = writer();
    const s = await converse(
      [() => call(1, "plan_update_entry", { id: "a", data: { Title: "New" } }), apply(2, 0), apply(3, 0)],
      { client },
    );
    expect(s.replies[1]!.result.isError).toBe(false);
    expect(dataOf(s.replies[1]!)).toEqual({ id: "a", version: 4 });
    expect(s.replies[2]!.result.isError).toBe(true);
    expect(errorOf(s.replies[2]!).code).toBe("usage");
    // One dry run and one write.
    expect(contents.update).toHaveBeenCalledTimes(2);
  });

  it("a failed apply spends the token", async () => {
    const { client, contents } = writer({ update: vi.fn().mockImplementation(async (_i: string, _d: unknown, o?: { dryRun?: boolean }) => {
      if (o?.dryRun) return { dryRun: true, changes: [] };
      throw new BarakoError(500, "boom");
    }) });
    const s = await converse([() => call(1, "plan_update_entry", { id: "a", data: { Title: "N" } }), apply(2, 0), apply(3, 0)], { client });
    expect(errorOf(s.replies[1]!).code).toBe("server");
    expect(errorOf(s.replies[2]!).message).toContain("no such plan");
    expect(contents.update).toHaveBeenCalledTimes(2);
  });

  it("an expired token is refused", async () => {
    let t = START;
    const { client, contents } = writer();
    const s = await converse(
      [
        () => call(1, "plan_update_entry", { id: "a", data: { Title: "New" } }),
        () => {
          t += PLAN_TTL_MS;
          return call(2, "ping");
        },
        apply(3, 0),
      ],
      { client, now: () => new Date(t) },
    );
    expect(s.replies[2]!.result.isError).toBe(true);
    expect(errorOf(s.replies[2]!).message).toContain("no such plan");
    expect(contents.update).toHaveBeenCalledTimes(1);
  });

  it("a token is still good one millisecond before it expires", async () => {
    let t = START;
    const { client } = writer();
    const s = await converse(
      [
        () => call(1, "plan_update_entry", { id: "a", data: { Title: "New" } }),
        () => {
          t += PLAN_TTL_MS - 1;
          return call(2, "ping");
        },
        apply(3, 0),
      ],
      { client, now: () => new Date(t) },
    );
    expect(s.replies[2]!.result.isError).toBe(false);
  });

  it("apply_plan refuses a destructive plan and the reverse", async () => {
    const { client, contents } = writer();
    const s = await converse(
      [
        () => call(1, "plan_erase_entry", { id: "a" }),
        // The plan's own action on the wrong tool is refused before the plan is looked up.
        apply(2, 0, "apply_plan"),
        () => call(3, "plan_update_entry", { id: "a", data: { Title: "New" } }),
        apply(4, 2, "apply_destructive_plan"),
        // An action the tool lists but the plan does not have reaches the plan, which is then removed.
        apply(5, 0, "apply_plan", { action: "update_entry" }),
        apply(6, 0, "apply_destructive_plan"),
        apply(7, 2, "apply_plan"),
      ],
      { client, destructive: true },
    );
    expect(errorOf(s.replies[1]!).message).toContain("apply_destructive_plan");
    expect(errorOf(s.replies[3]!).message).toContain("apply_destructive_plan");
    expect(errorOf(s.replies[4]!).message).toContain("other apply tool");
    expect(errorOf(s.replies[5]!).message).toContain("no such plan");
    expect(s.replies[6]!.result.isError).toBe(false);
    expect(contents.erase).not.toHaveBeenCalled();
    // One dry run at plan time and one apply.
    expect(contents.update).toHaveBeenCalledTimes(2);
  });

  it("apply sends exactly the planned update with If-Match and version", async () => {
    const { client, contents } = writer();
    const s = await converse(
      [() => call(1, "plan_update_entry", { id: "a", data: { Title: "New" } }), apply(2, 0)],
      { client },
    );
    const plan = dataOf(s.replies[0]!);
    expect(Object.keys(plan)).toEqual(["token", "expiresAt", "action", "target", "changes"]);
    expect(plan.action).toBe("update_entry");
    expect(plan.target).toBe("a");
    expect(plan.expiresAt).toBe("2026-11-24T10:10:00.000Z");
    expect(plan.changes).toEqual([{ field: "Title", to: "New" }]);
    const merged = { Title: "New", Body: "B" };
    expect(contents.update.mock.calls).toEqual([
      ["a", { data: merged, version: 3 }, { ifMatch: '"e1"', dryRun: true }],
      ["a", { data: merged, version: 3 }, { ifMatch: '"e1"' }],
    ]);
    expect(dataOf(s.replies[1]!)).toEqual({ id: "a", version: 4 });
  });

  it("replace sends the data as given, with no merge", async () => {
    const { client, contents } = writer();
    await converse([() => call(1, "plan_update_entry", { id: "a", data: { Title: "Only" }, replace: true }), apply(2, 0)], { client });
    expect(contents.update.mock.calls.at(-1)).toEqual(["a", { data: { Title: "Only" }, version: 3 }, { ifMatch: '"e1"' }]);
  });

  it("an update plan with no version and no ETag is refused with version_required", async () => {
    const { client, contents } = writer({ get: vi.fn().mockResolvedValue({ ...ENTRY, version: 0, etag: undefined }) });
    const s = await converse([() => call(1, "plan_update_entry", { id: "a", data: { Title: "N" } }), () => call(2, "plan_erase_entry", { id: "a" })], { client, destructive: true });
    expect(errorOf(s.replies[0]!).code).toBe("version_required");
    expect(errorOf(s.replies[1]!).code).toBe("version_required");
    expect(contents.update).not.toHaveBeenCalled();
  });

  it("version 0 with an ETag is a normal plan", async () => {
    const { client, contents } = writer({ get: vi.fn().mockResolvedValue({ ...ENTRY, version: 0 }) });
    await converse([() => call(1, "plan_update_entry", { id: "a", data: { Title: "N" } }), apply(2, 0)], { client });
    expect(contents.update.mock.calls.at(-1)![1]).toMatchObject({ version: 0 });
  });

  it("empty or non-object data is a usage error and sends nothing", async () => {
    const { client, contents } = writer();
    const s = await converse(
      [
        () => call(1, "plan_create_entry", { contentType: "post", data: {} }),
        () => call(2, "plan_update_entry", { id: "a", data: {}, replace: true }),
        () => call(3, "plan_update_entry", { id: "a", data: [1] }),
        () => call(4, "plan_create_entry", { contentType: "post", data: null }),
        () => call(5, "plan_create_entry", { contentType: "post", data: { A: 1 }, publish: "yes" }),
      ],
      { client },
    );
    for (const r of s.replies) expect(errorOf(r).code).toBe("usage");
    expect(errorOf(s.replies[0]!).message).toContain("Nothing to change");
    expect(contents.create).not.toHaveBeenCalled();
    expect(contents.get).not.toHaveBeenCalled();
  });

  it("the create dry run sends no idempotency key and apply sends the one made at plan time", async () => {
    const { client, contents } = writer();
    const s = await converse(
      [() => call(1, "plan_create_entry", { contentType: "post", data: { Title: "New" }, publish: true }), apply(2, 0)],
      { client },
    );
    const [dry, real] = contents.create.mock.calls;
    expect(dry).toEqual([{ contentType: "post", data: { Title: "New" }, status: "Published" }, { dryRun: true }]);
    expect(Object.keys(dry![1])).not.toContain("idempotencyKey");
    expect(real![0]).toEqual(dry![0]);
    expect(real![1].idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
    expect(real![1].dryRun).toBeUndefined();
    expect(dataOf(s.replies[0]!).target).toBe("post");
    expect(dataOf(s.replies[1]!)).toEqual({ id: "n1", version: 1 });
  });

  it("create is a draft unless publish is true, and each plan has its own key", async () => {
    const { client, contents } = writer();
    await converse(
      [() => call(1, "plan_create_entry", { contentType: "post", data: { A: 1 } }), apply(2, 0), () => call(3, "plan_create_entry", { contentType: "post", data: { A: 1 } }), apply(4, 2)],
      { client },
    );
    const real = contents.create.mock.calls.filter((c) => !c[1].dryRun);
    expect(real[0]![0].status).toBe("Draft");
    expect(real[0]![1].idempotencyKey).not.toBe(real[1]![1].idempotencyKey);
  });

  it("a status change shows from and to, then sends the status once the entry matches", async () => {
    const { client, contents } = writer();
    const s = await converse(
      [() => call(1, "plan_change_status", { id: "a", action: "publish" }), apply(2, 0)],
      { client },
    );
    expect(dataOf(s.replies[0]!).changes).toEqual({ from: "draft", to: "published" });
    expect(contents.setStatus.mock.calls).toEqual([["a", "Published"]]);
    expect(dataOf(s.replies[1]!)).toEqual({ id: "a", status: "published" });
  });

  it("restore plans only from an archived entry", async () => {
    const { client, contents } = writer();
    const s = await converse([() => call(1, "plan_change_status", { id: "a", action: "restore" })], { client });
    expect(errorOf(s.replies[0]!).code).toBe("usage");
    expect(contents.setStatus).not.toHaveBeenCalled();
    const archived = writer({ get: vi.fn().mockResolvedValue({ ...ENTRY, status: "Archived" }) });
    const ok = await converse([() => call(1, "plan_change_status", { id: "a", action: "restore" }), apply(2, 0)], { client: archived.client });
    expect(dataOf(ok.replies[0]!).changes).toEqual({ from: "archived", to: "draft" });
    expect(archived.contents.setStatus.mock.calls).toEqual([["a", "Draft"]]);
  });

  it("a rollback plan carries the version id unchecked, and apply sends it", async () => {
    const { client, contents } = writer();
    const s = await converse(
      [() => call(1, "plan_rollback_entry", { id: "a", versionId: "v-9" }), apply(2, 0, "apply_destructive_plan")],
      { client, destructive: true },
    );
    expect(dataOf(s.replies[0]!).changes).toEqual({ contentType: "post", status: "draft", currentVersion: 3, versionId: "v-9" });
    expect(contents.rollback.mock.calls).toEqual([["a", "v-9"]]);
    // The entry the server answers with is not passed on.
    expect(dataOf(s.replies[1]!)).toEqual({ id: "a" });
  });

  it("a 403 on erase names content:destructive", async () => {
    const { client, contents } = writer({ erase: vi.fn().mockRejectedValue(new BarakoError(403, "Forbidden")) });
    const s = await converse(
      [() => call(1, "plan_erase_entry", { id: "a" }), apply(2, 0, "apply_destructive_plan")],
      { client, destructive: true },
    );
    expect(dataOf(s.replies[0]!).changes).toEqual({ contentType: "post", status: "draft", currentVersion: 3 });
    expect(s.replies[1]!.result.isError).toBe(true);
    expect(errorOf(s.replies[1]!).code).toBe("forbidden");
    expect(errorOf(s.replies[1]!).status).toBe(403);
    expect(errorOf(s.replies[1]!).message).toContain("content:destructive");
    expect(contents.erase).toHaveBeenCalledTimes(1);
  });

  it("an erase applies and answers with the id", async () => {
    const { client, contents } = writer();
    const s = await converse([() => call(1, "plan_erase_entry", { id: "a" }), apply(2, 0, "apply_destructive_plan")], { client, destructive: true });
    expect(contents.erase.mock.calls).toEqual([["a"]]);
    expect(dataOf(s.replies[1]!)).toEqual({ erased: "a" });
  });

  it("a conflict at apply says to plan again and passes no server details", async () => {
    const err = new BarakoError(412, "stale: Secret title text", { detail: "Secret title text" });
    const { client } = writer({
      update: vi.fn().mockImplementation(async (_i: string, _d: unknown, o?: { dryRun?: boolean }) => {
        if (o?.dryRun) return { dryRun: true, changes: [] };
        throw err;
      }),
    });
    const s = await converse([() => call(1, "plan_update_entry", { id: "a", data: { Title: "N" } }), apply(2, 0)], { client });
    const e = errorOf(s.replies[1]!);
    expect(e).toEqual({ code: "conflict", status: 412, message: "The entry changed since the plan, plan again." });
    expect(s.replies[1]!.result.content[0].text).not.toContain("Secret");
  });
});

describe("mcp write tools: size and store", () => {
  it("a plan over the size cap returns no token and keeps no plan", async () => {
    const big = "x".repeat(RESULT_CAP_BYTES + 10);
    const { client, contents } = writer({
      create: vi.fn().mockImplementation(async (input: { contentType: string }, opts?: { dryRun?: boolean }) =>
        opts?.dryRun ? { dryRun: true, changes: input.contentType === "big" ? [{ v: big }] : [] } : { id: "n1", version: 1 },
      ),
    });
    const steps: Step[] = [
      ...Array.from({ length: MAX_PLANS }, (_, i): Step => () => call(i + 1, "plan_create_entry", { contentType: `t${i}`, data: { A: 1 } })),
      () => call(100, "plan_create_entry", { contentType: "big", data: { A: 1 } }),
      // The too-large plan evicted nothing, so the first plan still applies.
      apply(101, 0),
    ];
    const s = await converse(steps, { client });
    const tooLarge = s.replies[MAX_PLANS]!;
    expect(tooLarge.result.isError).toBe(true);
    expect(tooLarge.result.content[0].text).not.toContain("token");
    expect(tooLarge.result.content[0].text).toContain("no plan was made");
    expect(s.replies[MAX_PLANS + 1]!.result.isError).toBe(false);
    expect(contents.create.mock.calls.filter((c) => !c[1].dryRun)).toHaveLength(1);
  });

  it("the oldest plan is dropped past 20", async () => {
    const { client, contents } = writer();
    const steps: Step[] = [
      ...Array.from({ length: MAX_PLANS + 1 }, (_, i): Step => () => call(i + 1, "plan_create_entry", { contentType: `t${i}`, data: { A: 1 } })),
      apply(100, 0),
      apply(101, 1),
    ];
    const s = await converse(steps, { client });
    expect(errorOf(s.replies[MAX_PLANS + 1]!).message).toContain("no such plan");
    expect(s.replies[MAX_PLANS + 2]!.result.isError).toBe(false);
    expect(contents.create.mock.calls.filter((c) => !c[1].dryRun)).toHaveLength(1);
  });

  it("an expired plan does not count toward the 20", async () => {
    let t = START;
    const { client } = writer();
    const steps: Step[] = [
      () => call(1, "plan_create_entry", { contentType: "old", data: { A: 1 } }),
      () => {
        t += PLAN_TTL_MS;
        return call(2, "plan_create_entry", { contentType: "t", data: { A: 1 } });
      },
      apply(3, 1),
    ];
    const s = await converse(steps, { client, now: () => new Date(t) });
    expect(s.replies[2]!.result.isError).toBe(false);
  });
});

describe("mcp write tools: logs and data", () => {
  it("the token is in no log line", async () => {
    const { client } = writer();
    const s = await converse(
      [
        () => call(1, "plan_update_entry", { id: "a", data: { Title: "Value that stays out" } }),
        apply(2, 0),
        apply(3, 0),
        (r) => call(4, "apply_plan", { token: tokenOf(r[0]!), action: "update_entry", target: tokenOf(r[0]!) }),
      ],
      { client },
    );
    const token = tokenOf(s.replies[0]!);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(s.log.join("\n")).not.toContain(token);
    expect(s.log.join("\n")).not.toContain("stays out");
    expect(s.log).toEqual([
      '2026-11-24T10:00:00.000Z tool="plan_update_entry" target="a" status=ok',
      '2026-11-24T10:00:00.000Z tool="apply_plan" target="a" status=ok',
      '2026-11-24T10:00:00.000Z tool="apply_plan" target=- status=error:usage:0',
      '2026-11-24T10:00:00.000Z tool="apply_plan" target=- status=error:usage:0',
    ]);
  });

  it("a create logs the content type and an apply logs the plan's target", async () => {
    const { client } = writer();
    const s = await converse([() => call(1, "plan_create_entry", { contentType: "post", data: { A: 1 } }), apply(2, 0)], { client });
    expect(s.log[0]).toContain('tool="plan_create_entry" target="post"');
    expect(s.log[1]).toContain('tool="apply_plan" target="post" status=ok');
  });

  it("a __proto__ field stays data", async () => {
    const dry = JSON.parse('{"dryRun":true,"changes":[{"__proto__":{"to":"x"},"field":"F"}]}');
    const held = JSON.parse('{"__proto__":{"kept":1},"Title":"Old"}');
    const { client, contents } = writer({
      get: vi.fn().mockResolvedValue({ ...ENTRY, data: held }),
      update: vi.fn().mockImplementation(async (_i: string, _d: unknown, o?: { dryRun?: boolean }) => (o?.dryRun ? dry : { id: "a", version: 4 })),
    });
    const line = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"plan_update_entry","arguments":{"id":"a","data":{"__proto__":{"set":2},"Title":"New"}}}}';
    const s = await converse([() => line, apply(2, 0)], { client });
    // The body sent: the new __proto__ value replaces the held one, as an own key.
    const sent = contents.update.mock.calls.at(-1)![1].data as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(sent, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(sent, "__proto__")!.value).toEqual({ set: 2 });
    expect(Object.getPrototypeOf(sent)).toBe(Object.prototype);
    expect(sent.Title).toBe("New");
    // The result shown: the key survives the scrub.
    const change = dataOf(s.replies[0]!).changes[0];
    expect(Object.keys(change)).toEqual(["__proto__", "field"]);
    expect(Object.getOwnPropertyDescriptor(change, "__proto__")!.value).toEqual({ to: "x" });
    expect(s.replies[0]!.result.content[0].text).toContain('"__proto__":{"to":"x"}');
  });
});

describe("mcp write tools: gaps", () => {
  const CHANGES: Record<string, unknown>[] = [{ etag: '"e2"' }, { version: 4 }, { status: "Published" }];

  async function refusedAfterChange(planTool: string, planArgs: Json, applyTool: string, destructive: boolean, called: (c: ReturnType<typeof writer>["contents"]) => unknown) {
    for (const change of CHANGES) {
      const { client, contents } = writer();
      const s = await converse(
        [
          () => call(1, planTool, planArgs),
          () => {
            contents.get.mockResolvedValue({ ...ENTRY, ...change });
            return call(2, "ping");
          },
          apply(3, 0, applyTool),
        ],
        { client, destructive },
      );
      expect(s.replies[2]!.result.isError).toBe(true);
      expect(errorOf(s.replies[2]!).code).toBe("conflict");
      expect(errorOf(s.replies[2]!).message).toBe("The entry changed since the plan, plan again.");
      expect(called(contents)).not.toHaveBeenCalled();
    }
  }

  it("a status plan is refused after the target changed", async () => {
    await refusedAfterChange("plan_change_status", { id: "a", action: "publish" }, "apply_plan", false, (c) => c.setStatus);
  });

  it("a rollback plan is refused after the target changed", async () => {
    await refusedAfterChange("plan_rollback_entry", { id: "a", versionId: "v-9" }, "apply_destructive_plan", true, (c) => c.rollback);
  });

  it("an erase plan is refused after the target changed", async () => {
    await refusedAfterChange("plan_erase_entry", { id: "a" }, "apply_destructive_plan", true, (c) => c.erase);
  });

  it("a token that is not base64url is refused before any lookup", async () => {
    const { client, contents } = writer();
    const s = await converse(
      [
        () => call(1, "plan_update_entry", { id: "a", data: { Title: "New" } }),
        () => call(2, "apply_plan", { token: "abc$%", action: "update_entry", target: "a" }),
        () => call(3, "apply_plan", { token: "A".repeat(65), action: "update_entry", target: "a" }),
        apply(4, 0),
      ],
      { client },
    );
    for (const i of [1, 2]) {
      expect(s.replies[i]!.result.isError).toBe(true);
      expect(errorOf(s.replies[i]!).message).toBe('"token" must be the token the plan returned.');
      expect(errorOf(s.replies[i]!).message).not.toContain("no such plan");
    }
    // The plan is still there, so the bad tokens touched nothing.
    expect(s.replies[3]!.result.isError).toBe(false);
    expect(contents.update.mock.calls.filter((c) => !c[2].dryRun)).toHaveLength(1);
  });

  it("expired plans are purged before the cap", async () => {
    let t = START;
    const { client } = writer();
    const steps: Step[] = [
      ...Array.from({ length: MAX_PLANS }, (_, i): Step => () => call(i + 1, "plan_create_entry", { contentType: `t${i}`, data: { A: 1 } })),
      () => {
        t += PLAN_TTL_MS;
        return call(100, "plan_create_entry", { contentType: "fresh", data: { A: 1 } });
      },
      apply(101, MAX_PLANS),
      apply(102, 0),
    ];
    const s = await converse(steps, { client, now: () => new Date(t) });
    expect(s.replies[MAX_PLANS + 1]!.result.isError).toBe(false);
    expect(errorOf(s.replies[MAX_PLANS + 2]!).message).toContain("no such plan");
  });

  it("the store holds one plan after expired ones are purged on commit", () => {
    let t = START;
    const store = new PlanStore(() => new Date(t));
    const plan = (token: string): Plan => ({ token, expiresAt: store.issue().expiresAt, target: "a", action: "erase_entry", fingerprint: { version: 1, etag: undefined, status: undefined } });
    for (let i = 0; i < MAX_PLANS; i++) store.commit(plan(`p${i}`));
    expect(store.size).toBe(MAX_PLANS);
    t += PLAN_TTL_MS;
    store.commit(plan("fresh"));
    expect(store.size).toBe(1);
    expect(store.take("p0")).toBeUndefined();
    expect(store.take("fresh")?.token).toBe("fresh");
  });

  it("a token expires at exactly the TTL and not one millisecond earlier", () => {
    let t = START;
    const store = new PlanStore(() => new Date(t));
    const { token, expiresAt } = store.issue();
    store.commit({ token, expiresAt, target: "a", action: "erase_entry", fingerprint: { version: 1, etag: undefined, status: undefined } });
    t = START + PLAN_TTL_MS - 1;
    expect(store.size).toBe(1);
    t = START + PLAN_TTL_MS;
    expect(store.size).toBe(0);
    expect(store.take(token)).toBeUndefined();
  });
});

describe("mcp write tools: thin answers, limits and token handling", () => {
  const real = (c: { mock: { calls: any[][] } }) => c.mock.calls.filter((x) => !x.at(-1)?.dryRun);

  it("an empty ETag counts as none: it is not sent and the fingerprint is still compared", async () => {
    const blank = { ...ENTRY, etag: "", version: 2 };
    const { client, contents } = writer({ get: vi.fn().mockResolvedValue({ ...blank }) });
    const s = await converse(
      [
        () => call(1, "plan_update_entry", { id: "a", data: { Title: "New" } }),
        apply(2, 0),
        () => call(3, "plan_update_entry", { id: "a", data: { Title: "New" } }),
        () => {
          contents.get.mockResolvedValue({ ...blank, version: 5 });
          return call(4, "ping");
        },
        apply(5, 2),
      ],
      { client },
    );
    expect(s.replies[1]!.result.isError).toBe(false);
    expect(real(contents.update)[0]![2]).toEqual({});
    expect(contents.update.mock.calls[0]![2]).toEqual({ dryRun: true });
    expect(s.replies[4]!.result.isError).toBe(true);
    expect(errorOf(s.replies[4]!).message).toContain("changed since the plan");
    expect(real(contents.update)).toHaveLength(1);
  });

  it("an empty ETag at plan and no ETag at apply are the same fingerprint", async () => {
    const { client, contents } = writer({ get: vi.fn().mockResolvedValue({ ...ENTRY, etag: "", version: 2 }) });
    const s = await converse(
      [
        () => call(1, "plan_update_entry", { id: "a", data: { Title: "New" } }),
        () => {
          contents.get.mockResolvedValue({ ...ENTRY, etag: undefined, version: 2 });
          return call(2, "ping");
        },
        apply(3, 0),
      ],
      { client },
    );
    expect(s.replies[2]!.result.isError).toBe(false);
    expect(real(contents.update)).toHaveLength(1);
  });

  it("an empty ETag with version 0 is refused at plan", async () => {
    const { client, contents } = writer({ get: vi.fn().mockResolvedValue({ ...ENTRY, etag: "", version: 0 }) });
    const s = await converse([() => call(1, "plan_update_entry", { id: "a", data: { Title: "New" } })], { client });
    expect(s.replies[0]!.result.isError).toBe(true);
    expect(errorOf(s.replies[0]!).code).toBe("version_required");
    expect(errorOf(s.replies[0]!).message).toBe("The server returned neither a version nor an ETag for this entry, so no plan was made.");
    expect(contents.update).not.toHaveBeenCalled();
  });

  it("a numeric status plans a restore from archived", async () => {
    const { client } = writer({ get: vi.fn().mockResolvedValue({ ...ENTRY, status: 2 }) });
    const s = await converse([() => call(1, "plan_change_status", { id: "a", action: "restore" })], { client });
    expect(dataOf(s.replies[0]!).changes).toEqual({ from: "archived", to: "draft" });
  });

  it("an entry with no status cannot be restored", async () => {
    const { status: _s, ...noStatus } = ENTRY;
    const { client } = writer({ get: vi.fn().mockResolvedValue(noStatus) });
    const s = await converse([() => call(1, "plan_change_status", { id: "a", action: "restore" })], { client });
    expect(s.replies[0]!.result.isError).toBe(true);
    expect(errorOf(s.replies[0]!).code).toBe("usage");
    expect(errorOf(s.replies[0]!).message).toBe("Only an archived entry can be restored.");
  });

  it("a create answered with nothing still reports it was made", async () => {
    const { client, contents } = writer({
      create: vi.fn().mockImplementation(async (_i: unknown, opts?: { dryRun?: boolean }) => (opts?.dryRun ? { dryRun: true, changes: [] } : undefined)),
    });
    const s = await converse([() => call(1, "plan_create_entry", { contentType: "post", data: { A: 1 } }), apply(2, 0)], { client });
    expect(s.replies[1]!.result.isError).toBe(false);
    expect(dataOf(s.replies[1]!)).toEqual({
      created: true,
      note: "The entry was created. The answer had no id. List the entries before you plan another create.",
    });
    expect(real(contents.create)).toHaveLength(1);
  });

  it("an update answered with nothing still reports the id", async () => {
    const { client } = writer({
      update: vi.fn().mockImplementation(async (_i: string, _d: unknown, opts?: { dryRun?: boolean }) => (opts?.dryRun ? { dryRun: true, changes: [] } : undefined)),
    });
    const s = await converse([() => call(1, "plan_update_entry", { id: "a", data: { Title: "New" } }), apply(2, 0)], { client });
    expect(s.replies[1]!.result.isError).toBe(false);
    expect(dataOf(s.replies[1]!)).toEqual({ id: "a" });
  });

  it("a rollback answered with nothing falls back to the plan's target", async () => {
    const { client } = writer({ rollback: vi.fn().mockResolvedValue(undefined) });
    const s = await converse(
      [() => call(1, "plan_rollback_entry", { id: "a", versionId: "v-9" }), apply(2, 0, "apply_destructive_plan")],
      { client, destructive: true },
    );
    expect(s.replies[1]!.result.isError).toBe(false);
    expect(dataOf(s.replies[1]!)).toEqual({ id: "a" });
  });

  it("a create plan over the size cap is refused and nothing is sent", async () => {
    const { client, contents } = writer();
    const s = await converse(
      [() => call(1, "plan_create_entry", { contentType: "post", data: { Body: "x".repeat(RESULT_CAP_BYTES + 10) } }), apply(2, 0)],
      { client },
    );
    expect(s.replies[0]!.result.isError).toBe(true);
    expect(s.replies[0]!.result.content[0].text).toContain("no plan was made");
    expect(s.replies[0]!.result.content[0].text).not.toContain("token");
    expect(contents.create).not.toHaveBeenCalled();
  });

  it("an update plan whose merged data is over the size cap is refused and nothing is sent", async () => {
    const { client, contents } = writer();
    const s = await converse(
      [() => call(1, "plan_update_entry", { id: "a", data: { Body: "x".repeat(RESULT_CAP_BYTES + 10) } })],
      { client },
    );
    expect(s.replies[0]!.result.isError).toBe(true);
    expect(s.replies[0]!.result.content[0].text).toContain("no plan was made");
    expect(contents.update).not.toHaveBeenCalled();
  });

  it("a wrong action for the apply tool is an argument error and the plan survives", async () => {
    const { client, contents } = writer();
    const s = await converse(
      [
        () => call(1, "plan_erase_entry", { id: "a" }),
        apply(2, 0, "apply_plan"),
        apply(3, 0, "apply_destructive_plan"),
      ],
      { client, destructive: true },
    );
    expect(s.replies[1]!.result.isError).toBe(true);
    expect(errorOf(s.replies[1]!).code).toBe("usage");
    expect(errorOf(s.replies[1]!).message).toContain('"action" is not one this tool applies.');
    expect(s.replies[2]!.result.isError).toBe(false);
    expect(contents.erase.mock.calls).toEqual([["a"]]);
  });

  it("a live token passed as the target is refused, leaks nowhere and spares the other plan", async () => {
    const { client, contents } = writer();
    const s = await converse(
      [
        () => call(1, "plan_update_entry", { id: "a", data: { Title: "A" } }),
        () => call(2, "plan_update_entry", { id: "a", data: { Title: "B" } }),
        (r) => call(3, "apply_plan", { token: tokenOf(r[0]!), action: "update_entry", target: tokenOf(r[1]!) }),
        apply(4, 1),
      ],
      { client },
    );
    expect(s.replies[2]!.result.isError).toBe(true);
    expect(errorOf(s.replies[2]!).message).toContain("does not match the plan");
    const tokens = [tokenOf(s.replies[0]!), tokenOf(s.replies[1]!)];
    for (const line of s.log) for (const t of tokens) expect(line).not.toContain(t);
    expect(s.replies[3]!.result.isError).toBe(false);
    expect(real(contents.update)).toHaveLength(1);
  });
});
