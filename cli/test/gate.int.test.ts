import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { applyOf, mcpSession, resultData, toolCall } from "./mcp-session";

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

/** Reads until `done` accepts the value. Gives up after WAIT_MS and says what the last read was. */
async function until<T>(what: string, read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (done(last)) return last;
    if (Date.now() + POLL_MS > deadline) throw new Error(`${what} did not settle in ${WAIT_MS / 1000} s. Last value: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

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
    const data = await until(
      "OnHand",
      () => readData(product!),
      (d) => Number(d.OnHand) === 7,
    );
    expect(Number(data.OnHand)).toBe(7);
  }, 4 * 60_000);

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
    const data = await until(
      "HoursLast7Days",
      () => readData(employee!),
      (d) => Number(d.HoursLast7Days) === 8.5,
    );
    expect(Number(data.HoursLast7Days)).toBe(8.5);
  }, 4 * 60_000);

  it.skipIf(KIT !== "blog")("blog: a published post shows on the Press site", async () => {
    const title = `Gate check ${suffix()}`;
    await createEntries([{ contentType: "post", data: () => ({ Title: title, Slug: `gate-check-${suffix()}`, Body: "Made by the gate." }) }]);
    // Press caches pages, so give it time to pick the entry up.
    const page = await until(
      "the Press home page",
      async () => {
        const p = await curl("client.localhost", "/");
        return { status: p.status, found: p.body.includes(title) };
      },
      (p) => p.status === 200 && p.found,
    );
    expect(page.found).toBe(true);
  }, 4 * 60_000);
});
