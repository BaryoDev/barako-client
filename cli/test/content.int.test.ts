import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs the built CLI against a live server. Skipped unless BARAKO_URL is set.
// Start the stack in cli/test/compose.yml first. See cli/README.md.

const BASE = (process.env.BARAKO_URL ?? "").replace(/\/+$/, "");
const ADMIN_USER = process.env.BARAKO_ADMIN_USER ?? "cliadmin";
const ADMIN_PASSWORD = process.env.BARAKO_ADMIN_PASSWORD ?? "Cli-Test-Admin-1234!";
const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}

let apiKey = "";
let readKey = "";
let destructiveKey = "";
const runs: Run[] = [];
let tmp = "";

async function call(method: string, path: string, body?: unknown, token?: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

/** Sign-in answers 401 until the first-run seeder is done, and the auth limiter counts 401s
 *  (5 per 15 minutes), so wait on the readiness probe and sign in once. */
async function waitReady(): Promise<void> {
  const deadline = Date.now() + 150_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health/ready`);
      if (res.ok) return;
    } catch {
      // The server is not listening yet.
    }
    if (Date.now() >= deadline) throw new Error("The server did not become ready in 150s.");
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function login(username: string, password: string): Promise<string> {
  const res = await call("POST", "/api/auth/login", { username, password });
  if (!res?.token) throw new Error("sign-in gave no token");
  return res.token as string;
}

function barako(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [MAIN, ...args],
      {
        env: { PATH: process.env.PATH, BARAKO_URL: BASE, BARAKO_API_KEY: apiKey },
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 99) : 0;
        const text = (code === 0 ? stdout : stderr).trim();
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        const run = { code, stdout, stderr, json };
        runs.push(run);
        resolve(run);
      },
    );
  });
}

function statusOf(entry: any): string {
  const s = entry.status;
  return typeof s === "number" ? ["draft", "published", "archived", "scheduled"][s]! : String(s).toLowerCase();
}


/** Runs `barako mcp` with a key. Each step is sent after the reply to the one before it came back, so an
 *  apply step can read the token from the plan reply. Returns every reply and what the process wrote. */
async function mcpSession(key: string, flags: string[], steps: ((replies: any[]) => object)[]) {
  const child = spawn(process.execPath, [MAIN, "mcp", ...flags], {
    env: { PATH: process.env.PATH, BARAKO_URL: BASE, BARAKO_API_KEY: key },
  });
  let stdout = "";
  let stderr = "";
  let pending = "";
  const replies: any[] = [];
  child.stdout.setEncoding("utf8").on("data", (d: string) => {
    stdout += d;
    pending += d;
    for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
      replies.push(JSON.parse(pending.slice(0, nl)));
      pending = pending.slice(nl + 1);
    }
  });
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  for (const [i, step] of steps.entries()) {
    child.stdin.write(JSON.stringify(step(replies)) + "\n");
    const deadline = Date.now() + 30_000;
    while (replies.length <= i) {
      if (Date.now() > deadline) throw new Error("No reply from barako mcp.");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  child.stdin.end();
  expect(await closed).toBe(0);
  expect(stdout).not.toContain(key);
  expect(stderr).not.toContain(key);
  return replies;
}

const toolCall = (id: number, name: string, args: object) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const resultData = (reply: any) => JSON.parse(reply.result.content[0].text).data;
const applyOf = (name: string, id: number, planIndex: number) => (replies: any[]) => {
  const plan = resultData(replies[planIndex]);
  return toolCall(id, name, { token: plan.token, action: plan.action, target: plan.target });
};
const newPost = () => ({ Title: "From MCP", Slug: `mcp-${randomBytes(4).toString("hex")}`, Body: "# Hello\n" });

describe.skipIf(!BASE)("barako against a live server", () => {
  let id = "";
  let firstVersion = 0;
  let userToken = "";
  let mcpId = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "barako-int-"));
    const suffix = randomBytes(4).toString("hex");
    const userName = `cli_writer_${suffix}`;
    const userPassword = `Writer-${suffix}-Pass1!`;

    await waitReady();
    const admin = await login(ADMIN_USER, ADMIN_PASSWORD);

    // A second run on the same stack finds the blueprint already there.
    await call("POST", "/api/content-types/blueprints/blog", {}, admin).catch((err: Error) => {
      if (!err.message.includes(" answered 409:")) throw err;
    });

    const rule = { enabled: true };
    const role = await call(
      "POST",
      "/api/roles",
      {
        name: `cli-writer-${suffix}`,
        description: "Integration suite writer",
        isPlatform: true,
        systemCapabilities: ["manage_api_keys"],
        // Delete on post, so a 403 on erase can only come from the key's scopes.
        permissions: ["post", "page"].map((slug) => ({
          contentTypeSlug: slug,
          read: rule,
          create: rule,
          update: rule,
          ...(slug === "post" ? { delete: rule } : {}),
        })),
      },
      admin,
    );

    await call(
      "POST",
      "/api/auth/register",
      { username: userName, email: `${userName}@example.com`, password: userPassword },
      undefined,
    );
    const users = await call("GET", "/api/users?pageSize=100", undefined, admin);
    const user = (users.items as any[]).find((u) => u.username === userName);
    if (!user) throw new Error("The registered user was not found.");
    await call("POST", `/api/users/${user.id}/roles`, { roleId: role.id }, admin);

    // The key acts as whoever creates it, so the new user creates it.
    userToken = await login(userName, userPassword);
    const key = await call(
      "POST",
      "/api/api-keys",
      { name: `cli-int-${suffix}`, scopes: ["content:read", "content:write"] },
      userToken,
    );
    apiKey = key.key;
    if (!apiKey) throw new Error("The server returned no key.");
    // Two more keys from the same user, for the MCP write tests. Only their scopes differ.
    const read = await call("POST", "/api/api-keys", { name: `cli-int-ro-${suffix}`, scopes: ["content:read"] }, userToken);
    readKey = read.key;
    const destructive = await call(
      "POST",
      "/api/api-keys",
      { name: `cli-int-del-${suffix}`, scopes: ["content:read", "content:write", "content:destructive"] },
      userToken,
    );
    destructiveKey = destructive.key;
    if (!readKey || !destructiveKey) throw new Error("The server returned no key.");
  }, 240_000);

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("schema post exits 0 and lists Title", async () => {
    const run = await barako(["schema", "post"]);
    expect(run.code).toBe(0);
    expect(run.json.ok).toBe(true);
    expect(JSON.stringify(run.json.result)).toContain("Title");
  });

  it("content create makes a draft", async () => {
    const body = join(tmp, "body.md");
    writeFileSync(body, "# Hello\n\nA post written by the integration suite.\n");
    const run = await barako([
      "content", "create", "post",
      "--set", "Title=It",
      "--set", `Slug=it-${randomBytes(4).toString("hex")}`,
      "--set-file", `Body=${body}`,
    ]);
    expect(run.code).toBe(0);
    id = run.json.result.id;
    expect(id).toBeTruthy();
    const got = await barako(["content", "get", id]);
    expect(got.code).toBe(0);
    expect(statusOf(got.json.result)).toBe("draft");
    firstVersion = got.json.result.version;
  });

  it("an empty required title exits 2 and changes nothing", async () => {
    const run = await barako(["content", "update", id, "--set", "Title=", "--dry-run"]);
    expect(run.code).toBe(2);
    expect(run.json.ok).toBe(false);
    const got = await barako(["content", "get", id]);
    expect(got.json.result.data.Title).toBe("It");
    expect(got.json.result.version).toBe(firstVersion);
  });

  it("a stale --expect-version exits 3", async () => {
    const first = await barako(["content", "update", id, "--set", "Title=Second"]);
    expect(first.code).toBe(0);
    const run = await barako([
      "content", "update", id, "--set", "Title=New", "--expect-version", String(firstVersion),
    ]);
    expect(run.code).toBe(3);
    expect(run.json.error.code).toBe("conflict");
  });

  it("publish, archive and restore move the status 1, 2, 0", async () => {
    for (const [command, expected] of [["publish", "published"], ["archive", "archived"], ["restore", "draft"]] as const) {
      const run = await barako(["content", command, id]);
      expect(run.code).toBe(0);
      const got = await barako(["content", "get", id]);
      expect(statusOf(got.json.result)).toBe(expected);
    }
  });

  it("content history lists the versions", async () => {
    const run = await barako(["content", "history", id]);
    expect(run.code).toBe(0);
    expect(Array.isArray(run.json.result)).toBe(true);
    expect(run.json.result.length).toBeGreaterThanOrEqual(2);
  });

  it("content erase exits 5 without content:destructive", async () => {
    const run = await barako(["content", "erase", id, "--confirm", id]);
    expect(run.code).toBe(5);
    expect(run.json.error.code).toBe("forbidden");
  });

  it("barako mcp lists content types over stdio and prints only protocol on stdout", async () => {
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_content_types", arguments: {} } },
    ];
    const child = spawn(process.execPath, [MAIN, "mcp"], {
      env: { PATH: process.env.PATH, BARAKO_URL: BASE, BARAKO_API_KEY: apiKey },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
    child.stdin.end(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(await closed).toBe(0);
    const replies = stdout.trim().split("\n").map((l) => JSON.parse(l));
    for (const r of replies) expect(r.jsonrpc).toBe("2.0");
    expect(replies.map((r) => r.id)).toEqual([1, 2]);
    const result = replies[1].result;
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.content[0].text);
    expect(body.untrusted).toBe(true);
    expect(body.data).toContain("post");
    expect(stdout).not.toContain(apiKey);
    expect(stderr).not.toContain(apiKey);
  });

  it("mcp: a read-only key cannot create, the API refuses it", async () => {
    const replies = await mcpSession(readKey, ["--allow-writes"], [
      () => toolCall(1, "plan_create_entry", { contentType: "post", data: newPost() }),
      (r) => (r[0].result.isError ? { jsonrpc: "2.0", id: 2, method: "ping" } : applyOf("apply_plan", 2, 0)(r)),
    ]);
    // Unconfirmed on the live stack: if the dry run is answered before the scope check, the 403 comes on apply.
    const refused = replies[0].result.isError ? replies[0] : replies[1];
    expect(refused.result.isError).toBe(true);
    expect(resultData(refused).error.status).toBe(403);
  });

  it("mcp: a content:read and content:write key plans and applies a create", async () => {
    const data = newPost();
    const replies = await mcpSession(apiKey, ["--allow-writes"], [
      () => toolCall(1, "plan_create_entry", { contentType: "post", data }),
      applyOf("apply_plan", 2, 0),
    ]);
    expect(replies[0].result.isError).toBe(false);
    expect(replies[1].result.isError).toBe(false);
    mcpId = resultData(replies[1]).id;
    expect(mcpId).toBeTruthy();
    const got = await barako(["content", "get", mcpId]);
    expect(got.code).toBe(0);
    expect(got.json.result.data.Title).toBe("From MCP");
  });

  it("mcp: erase without content:destructive is refused with 403 naming the scope", async () => {
    const replies = await mcpSession(apiKey, ["--allow-writes", "--allow-destructive"], [
      () => toolCall(1, "plan_erase_entry", { id: mcpId }),
      applyOf("apply_destructive_plan", 2, 0),
    ]);
    expect(replies[0].result.isError).toBe(false);
    expect(replies[1].result.isError).toBe(true);
    const error = resultData(replies[1]).error;
    expect(error.status).toBe(403);
    expect(error.message).toContain("content:destructive");
    expect((await barako(["content", "get", mcpId])).code).toBe(0);
  });

  it("mcp: the same erase applies with content:destructive and the entry is gone", async () => {
    const replies = await mcpSession(destructiveKey, ["--allow-writes", "--allow-destructive"], [
      () => toolCall(1, "plan_erase_entry", { id: mcpId }),
      applyOf("apply_destructive_plan", 2, 0),
    ]);
    expect(replies[1].result.isError, JSON.stringify(resultData(replies[1]))).toBe(false);
    expect(resultData(replies[1])).toEqual({ erased: mcpId });
    expect((await barako(["content", "get", mcpId])).code).toBe(4);
  });

  it("no run printed the key", () => {
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.stdout).not.toContain(apiKey);
      expect(run.stderr).not.toContain(apiKey);
    }
  });
});
