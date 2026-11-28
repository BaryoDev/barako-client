import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { applyOf, mcpSession, resultData, toolCall } from "./mcp-session";
import { until } from "./until";

// The nightly gate: one built-in kit on a stack that runs core's master image, driven the way an agent
// drives it, through barako mcp. The stack is started first, by the gate job, with
//   barako up --kit <kit> --image core=ghcr.io/baryodev/barako-cms:master
// so this file starts nothing. It is skipped unless BARAKO_GATE_KIT is set, so the build and live jobs
// never run it. One kit per run: the stack is one compose project on one port, so two kits would clash.
//
// The key is read from the stack folder under HOME, which the job sets to a temporary folder. It is
// never printed. Every write passes publish: true, because rollups count Published entries only. Every
// wait is bounded and fails with the last value read.

const KIT = process.env.BARAKO_GATE_KIT ?? "";
const PORT = Number(process.env.BARAKO_GATE_PORT ?? 18080);
const API = "http://127.0.0.1:5005";
const KITS = ["inventory", "attendance", "blog"];
const WAIT_MS = 120_000;
const POLL_MS = 5_000;

let key = "";

interface Spec {
  contentType: string;
  /** The data, given the ids of the entries made before this one in the same call. */
  data: (ids: string[]) => Record<string, unknown>;
}

/** Plans and applies each spec in order in one MCP session, published, and returns the new ids. */
async function createEntries(specs: Spec[]): Promise<string[]> {
  const steps = specs.flatMap((s, k) => [
    (replies: any[]) =>
      toolCall(2 * k + 1, "plan_create_entry", {
        contentType: s.contentType,
        data: s.data(specs.slice(0, k).map((_, j) => resultData(replies[2 * j + 1]).id as string)),
        publish: true,
      }),
    applyOf("apply_plan", 2 * k + 2, 2 * k),
  ]);
  const replies = await mcpSession(API, key, ["--allow-writes"], steps);
  replies.forEach((r, i) => {
    expect(r.result.isError, `${specs[i >> 1]!.contentType}, ${i % 2 === 0 ? "plan" : "apply"}: ${JSON.stringify(r).slice(0, 400)}`).toBe(false);
  });
  return specs.map((_, k) => resultData(replies[2 * k + 1]).id as string);
}

/** The data of one entry, read through get_entry. */
async function readData(id: string): Promise<Record<string, unknown>> {
  const replies = await mcpSession(API, key, [], [() => toolCall(1, "get_entry", { id })]);
  expect(replies[0].result.isError, JSON.stringify(replies[0]).slice(0, 400)).toBe(false);
  return resultData(replies[0]).data as Record<string, unknown>;
}

/** Reads until `done` accepts the value, for at most WAIT_MS. A read that throws is tried again. See until.ts. */
const wait = <T>(what: string, read: () => Promise<T>, done: (v: T) => boolean) => until(what, read, done, { timeoutMs: WAIT_MS, intervalMs: POLL_MS });

function run(file: string, args: string[], timeout = 30_000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout, env: { PATH: process.env.PATH } }, (error, stdout) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 99) : 0, stdout });
    });
  });
}

/** One request to a stack host with no DNS, as the stack test makes it. */
async function curl(host: string, path: string): Promise<{ status: number; body: string }> {
  const marker = "\n__STATUS__";
  const r = await run("curl", ["-s", "--max-time", "20", "--resolve", `${host}:${PORT}:127.0.0.1`, "-w", `${marker}%{http_code}`, `http://${host}:${PORT}${path}`]);
  const at = r.stdout.lastIndexOf(marker);
  return { status: Number(r.stdout.slice(at + marker.length)), body: r.stdout.slice(0, at) };
}

const suffix = () => randomBytes(4).toString("hex");

/**
 * Adds one optional text field to a kit type through plan_add_field and apply_plan, reads the type back
 * with get_content_type, then plans and applies an entry that sets the field and reads it back. A 409
 * from core means a field change is still running on the type, so the add is tried again until the wait
 * ends. A refused add made no change, so trying again cannot add the field twice. Only that 409 is tried
 * again: a session that throws (a bad exit, no reply) fails the test, so a clean retry cannot hide it.
 */
async function addFieldAndUse(contentType: string, entry: () => Record<string, unknown>): Promise<void> {
  const fieldName = `GateNote${suffix()}`;
  const attempt = await wait(
    `a field added to ${contentType}`,
    async (): Promise<{ replies: any[] } | { failed: unknown }> => {
      try {
        return {
          replies: await mcpSession(API, key, ["--allow-writes"], [
            () => toolCall(1, "plan_add_field", { contentType, fieldName, kind: "string", displayName: "Gate note" }),
            applyOf("apply_plan", 2, 0),
          ]),
        };
      } catch (failed) {
        return { failed };
      }
    },
    (a) => "failed" in a || !(a.replies[1].result.isError && JSON.parse(a.replies[1].result.content[0].text).data?.error?.status === 409),
  );
  if ("failed" in attempt) throw attempt.failed;
  const added = attempt.replies;
  expect(added[0].result.isError, JSON.stringify(added[0]).slice(0, 400)).toBe(false);
  expect(added[1].result.isError, JSON.stringify(added[1]).slice(0, 400)).toBe(false);
  expect(resultData(added[1]).added).toBe(fieldName);

  const read = await mcpSession(API, key, [], [() => toolCall(1, "get_content_type", { name: contentType })]);
  expect(read[0].result.isError, JSON.stringify(read[0]).slice(0, 400)).toBe(false);
  const names = (resultData(read[0]).fields as { name: string }[]).map((f) => f.name);
  expect(names.map((n) => n.toLowerCase()), `fields of ${contentType}: ${names.join(", ")}`).toContain(fieldName.toLowerCase());

  const note = `Set by the gate ${suffix()}`;
  const [id] = await createEntries([{ contentType, data: () => ({ ...entry(), [fieldName]: note }) }]);
  const data = await readData(id!);
  const key2 = Object.keys(data).find((k) => k.toLowerCase() === fieldName.toLowerCase());
  expect(key2, `entry data: ${JSON.stringify(data).slice(0, 400)}`).toBeDefined();
  expect(data[key2!]).toBe(note);
}

describe.skipIf(KIT === "")("the nightly gate on core master", () => {
  beforeAll(() => {
    key = readFileSync(join(homedir(), ".barako", "stack", "api-key"), "utf8").trim();
    expect(key.length, "the stack's api-key file").toBeGreaterThan(16);
  });

  it("BARAKO_GATE_KIT names a kit the gate knows", () => {
    expect(KITS, "BARAKO_GATE_KIT").toContain(KIT);
  });

  it.skipIf(KIT !== "inventory")("inventory: a product's OnHand is the sum of its stock moves", async () => {
    const replies = await mcpSession(API, key, [], [() => toolCall(1, "list_content_types", {})]);
    const names = resultData(replies[0]) as string[];
    for (const n of ["product", "stock-move", "sales-order", "sales-order-line"]) {
      expect(names, `content types the key can read: ${names.join(", ")}`).toContain(n);
    }

    const tag = suffix();
    const [product] = await createEntries([
      { contentType: "product", data: () => ({ Name: `Gate product ${tag}`, Sku: `GATE-${tag}`, ReorderLevel: 5 }) },
      { contentType: "stock-move", data: ([p]) => ({ Product: p, Qty: 10, Reason: "received" }) },
      { contentType: "stock-move", data: ([p]) => ({ Product: p, Qty: -3, Reason: "sold" }) },
    ]);
    const data = await wait(
      "OnHand",
      () => readData(product!),
      (d) => Number(d.OnHand) === 7,
    );
    expect(Number(data.OnHand)).toBe(7);

    await addFieldAndUse("product", () => ({ Name: `Gate product ${tag}b`, Sku: `GATE-${tag}-B`, ReorderLevel: 5 }));
  }, 6 * 60_000);

  it.skipIf(KIT !== "attendance")("attendance: Hours is computed and HoursLast7Days follows the time entries", async () => {
    const replies = await mcpSession(API, key, [], [() => toolCall(1, "list_content_types", {})]);
    const names = resultData(replies[0]) as string[];
    for (const n of ["employee", "time-entry"]) {
      expect(names, `content types the key can read: ${names.join(", ")}`).toContain(n);
    }

    const tag = suffix();
    // 8.5 hours, ending a short while ago, so it is inside the last seven days at any time of day.
    const out = new Date(Date.now() - 30 * 60_000);
    const timeIn = new Date(out.getTime() - 8.5 * 3_600_000);
    const [employee, entry] = await createEntries([
      { contentType: "employee", data: () => ({ Name: `Gate employee ${tag}`, Email: `gate-${tag}@example.test` }) },
      { contentType: "time-entry", data: ([e]) => ({ Employee: e, TimeIn: timeIn.toISOString(), TimeOut: out.toISOString(), Note: "Made by the gate." }) },
    ]);
    const entryData = await readData(entry!);
    expect(Number(entryData.Hours), `time-entry data: ${JSON.stringify(entryData).slice(0, 400)}`).toBe(8.5);
    const data = await wait(
      "HoursLast7Days",
      () => readData(employee!),
      (d) => Number(d.HoursLast7Days) === 8.5,
    );
    expect(Number(data.HoursLast7Days)).toBe(8.5);

    await addFieldAndUse("employee", () => ({ Name: `Gate employee ${tag}b`, Email: `gate-${tag}-b@example.test` }));
  }, 6 * 60_000);

  it.skipIf(KIT !== "blog")("blog: a published post shows on the Press site", async () => {
    const title = `Gate check ${suffix()}`;
    await createEntries([{ contentType: "post", data: () => ({ Title: title, Slug: `gate-check-${suffix()}`, Body: "Made by the gate." }) }]);
    // Press caches pages, so give it time to pick the entry up.
    const page = await wait(
      "the Press home page",
      async () => {
        const p = await curl("client.localhost", "/");
        return { status: p.status, found: p.body.includes(title) };
      },
      (p) => p.status === 200 && p.found,
    );
    expect(page.found).toBe(true);

    await addFieldAndUse("post", () => ({ Title: `Gate field ${suffix()}`, Slug: `gate-field-${suffix()}`, Body: "Made by the gate." }));
  }, 6 * 60_000);
});
