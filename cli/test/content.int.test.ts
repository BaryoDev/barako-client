import { execFile } from "node:child_process";
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

describe.skipIf(!BASE)("barako against a live server", () => {
  let id = "";
  let firstVersion = 0;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "barako-int-"));
    const suffix = randomBytes(4).toString("hex");
    const userName = `cli_writer_${suffix}`;
    const userPassword = `Writer-${suffix}-Pass1!`;

    await waitReady();
    const admin = await login(ADMIN_USER, ADMIN_PASSWORD);

    await call("POST", "/api/content-types/blueprints/blog", {}, admin);

    const rule = { enabled: true };
    const role = await call(
      "POST",
      "/api/roles",
      {
        name: `cli-writer-${suffix}`,
        description: "Integration suite writer",
        isPlatform: true,
        systemCapabilities: ["manage_api_keys"],
        permissions: ["post", "page"].map((slug) => ({
          contentTypeSlug: slug,
          read: rule,
          create: rule,
          update: rule,
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
    const userToken = await login(userName, userPassword);
    const key = await call(
      "POST",
      "/api/api-keys",
      { name: `cli-int-${suffix}`, scopes: ["content:read", "content:write"] },
      userToken,
    );
    apiKey = key.key;
    if (!apiKey) throw new Error("The server returned no key.");
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

  it("no run printed the key", () => {
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.stdout).not.toContain(apiKey);
      expect(run.stderr).not.toContain(apiKey);
    }
  });
});
