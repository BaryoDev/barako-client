import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { run } from "../src/main";
import { commands } from "../src/registry";
import {
  dockerEnv,
  makeStackCommands,
  parsePort,
  realDeps,
  resolveKit,
  createPrivateFile,
  type DockerResult,
  type HttpReply,
  type HttpRequest,
  type StackDeps,
} from "../src/commands/stack";
import { CADDYFILE, COMPOSE_YML, VERSIONS_JSON } from "../src/stack/files";

type Reply = Partial<DockerResult>;
interface Call {
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

let home: string;
let calls: Call[];
let running: number;
let upReply: Reply;
let composeVersion: string;
let dockerMissing: boolean;
let busyPorts: number[];
let counter: number;
let psFails: boolean;
let volume: boolean;
let labelled: string;
let httpCalls: HttpRequest[];
let api: (req: HttpRequest) => HttpReply;
let clock: number;
/** True once compose up ran in this command, so ps shows the stack after it started. */
let afterUp: boolean;
/** How many services run after a good compose up. */
let runningAfterUp: number;
const SERVICE_NAMES = ["postgres", "api", "site", "console", "caddy"];
interface FakeBox {
  service: string;
  status: string;
  restarts: number;
  /** When Docker last started it, on the fake clock. */
  started: number;
}
/** The containers docker inspect reports at a time on the fake clock. */
let boxes: (at: number) => FakeBox[];
const steady = (): FakeBox[] => SERVICE_NAMES.map((service) => ({ service, status: "running", restarts: 0, started: -60_000 }));
/** The stderr for the nth inspect call (from 1) that fails, or undefined when it answers. */
let inspectFails: (n: number) => string | undefined;
let inspectCount: number;
/** Puts empty lines between and around the inspect rows. */
let inspectBlank: boolean;

const FAKE_KEY = "fake-api-key-for-tests";
const FAKE_JWT = "fake-jwt-for-tests";

/** A core that accepts everything the bootstrap sends. */
const happyApi = (req: HttpRequest): HttpReply => {
  const path = new URL(req.url).pathname;
  if (path === "/health/ready") return { status: 200, body: "Healthy" };
  if (path === "/api/auth/login") return { status: 200, body: JSON.stringify({ token: FAKE_JWT, refreshToken: "fake-refresh" }) };
  if (path === "/api/content-types" && req.method === "GET") return { status: 200, body: "[]" };
  if (path === "/api/tenants") return { status: 200, body: "{}" };
  if (path.startsWith("/api/content-types/blueprints/")) return { status: 200, body: "{}" };
  if (path === "/api/api-keys") return { status: 200, body: JSON.stringify({ key: FAKE_KEY }) };
  return { status: 404, body: "" };
};

function fakeDeps(): StackDeps {
  return {
    async docker(args, opts) {
      calls.push({ args, cwd: opts.cwd, env: opts.env });
      const ok = (r: Reply = {}): DockerResult => ({ code: 0, stdout: "", stderr: "", ...r });
      if (dockerMissing) return ok({ code: 127, stderr: "docker: not found" });
      if (args[0] === "version") return ok();
      if (args[0] === "volume" && args[1] === "inspect") return ok({ code: volume ? 0 : 1 });
      if (args[0] === "ps") return ok({ stdout: labelled });
      if (args[0] === "compose" && args[1] === "version") return ok({ stdout: composeVersion + "\n" });
      if (args.includes("ps") && args.includes("--status")) {
        if (psFails) return ok({ code: 1, stderr: "ps broke" });
        return ok({ stdout: SERVICE_NAMES.slice(0, afterUp ? runningAfterUp : running).join("\n") });
      }
      if (args.includes("ps") && args.includes("--quiet")) return ok({ stdout: boxes(clock).map((b) => `id-${b.service}`).join("\n") });
      if (args[0] === "inspect") {
        inspectCount += 1;
        const err = inspectFails(inspectCount);
        if (err !== undefined) return ok({ code: 1, stderr: err });
        const byId = new Map(boxes(clock).map((b) => [`id-${b.service}`, b]));
        const rows = args.filter((a) => byId.has(a)).map((id) => byId.get(id)!);
        const lines = rows.map((b) => `${b.service} ${b.status} ${b.restarts} ${new Date(b.started).toISOString()} /barako-${b.service}-1`);
        return ok({ stdout: inspectBlank ? `\n${lines.join("\n\n")}\n  \n` : lines.join("\n") });
      }
      if (args.includes("up")) {
        const r = ok(upReply);
        afterUp = r.code === 0;
        return r;
      }
      return ok();
    },
    async portFree(port) {
      return !busyPorts.includes(port);
    },
    token: (bytes) => {
      counter += 1;
      // Fake values only, long enough to look like real ones.
      return `fake${counter}`.padEnd(Math.ceil((bytes * 4) / 3), "x");
    },
    home: () => home,
    async http(req) {
      httpCalls.push(req);
      return api(req);
    },
    async sleep(ms) {
      clock += ms;
    },
    now: () => clock,
  };
}

function cmd(name: string) {
  const c = makeStackCommands(fakeDeps()).find((x) => x.name === name)!;
  return (args: Record<string, unknown> = {}, ctx: Record<string, unknown> = {}) => {
    afterUp = false;
    return c.run({ client: {} as never, readFile: () => "", ...ctx }, args) as Promise<Record<string, any>>;
  };
}

async function fails(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await fn();
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected the command to fail");
}

const dir = () => join(home, ".barako", "stack");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "barako-stack-test-"));
  calls = [];
  running = 0;
  upReply = {};
  composeVersion = "2.29.0";
  dockerMissing = false;
  busyPorts = [];
  counter = 0;
  psFails = false;
  volume = false;
  labelled = "";
  httpCalls = [];
  api = happyApi;
  clock = 0;
  afterUp = false;
  runningAfterUp = 5;
  boxes = steady;
  inspectFails = () => undefined;
  inspectCount = 0;
  inspectBlank = false;
  spawnMock.mockReset();
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("stack commands", () => {
  it("up, status, down and reset are registered offline", () => {
    for (const name of ["up", "status", "down", "reset"]) {
      const c = commands.find((x) => x.name === name);
      expect(c, name).toBeDefined();
      expect(c!.offline, name).toBe(true);
    }
  });
});

describe("port", () => {
  it("accepts integers from 1024 to 65535", () => {
    expect(parsePort(1024)).toBe(1024);
    expect(parsePort(65535)).toBe(65535);
    expect(parsePort("8080")).toBe(8080);
  });

  it("rejects 5005, the API host port", () => {
    expect(() => parsePort(5005)).toThrow(/5005/);
  });

  it.each([1023, 65536, 0, -1, 8080.5, NaN, "80abc", "", " 8080", "0x1F90", "1e3", undefined])(
    "rejects %s",
    (v) => {
      expect(() => parsePort(v)).toThrow(/1024 to 65535/);
    },
  );

  it("up with a bad port writes nothing and calls no docker", async () => {
    const e = await fails(() => cmd("up")({ port: 80 }));
    expect(e.code).toBe("usage");
    expect(calls).toEqual([]);
    expect(existsSync(dir())).toBe(false);
  });

  it("up stops when the port is in use and writes nothing", async () => {
    busyPorts = [8080];
    const e = await fails(() => cmd("up")({}));
    expect(e.message).toContain("8080");
    expect(existsSync(dir())).toBe(false);
    expect(calls.some((c) => c.args.includes("up"))).toBe(false);
  });

  it("up stops when the API port is in use", async () => {
    busyPorts = [5005];
    const e = await fails(() => cmd("up")({}));
    expect(e.message).toContain("5005");
    expect(existsSync(dir())).toBe(false);
  });
});

describe("files", () => {
  let oldMask = 0;
  beforeEach(() => {
    oldMask = process.umask(0o022);
  });
  afterEach(() => {
    process.umask(oldMask);
  });

  it("writes .env as 0600 in a 0700 directory, and only when absent", async () => {
    await cmd("up")({});
    expect(statSync(dir()).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir(), ".env")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir(), "state.json")).mode & 0o777).toBe(0o600);

    const before = readFileSync(join(dir(), ".env"), "utf8");
    const edited = before.replace(/ADMIN_PASSWORD=.*/, "ADMIN_PASSWORD=Aa1-edited-by-hand");
    writeFileSync(join(dir(), ".env"), edited, { mode: 0o600 });
    await cmd("up")({ port: 9090 });
    expect(readFileSync(join(dir(), ".env"), "utf8")).toBe(edited);
  });

  it("writes the stack files and state", async () => {
    await cmd("up")({ port: 9191 });
    for (const f of ["compose.yml", "Caddyfile", "app-role.sql", "versions.json", "state.json"]) {
      expect(existsSync(join(dir(), f)), f).toBe(true);
    }
    const state = JSON.parse(readFileSync(join(dir(), "state.json"), "utf8"));
    expect(state.port).toBe(9191);
    expect(state.tenant).toBe("client");
    expect(state.versions.core.tag).toBe("5.9.0");
    expect(state.latest).toBe(false);
  });

  it("generates secrets of the lengths core needs", async () => {
    await cmd("up")({});
    const env = Object.fromEntries(
      readFileSync(join(dir(), ".env"), "utf8").trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)),
    );
    expect(env.JWT_KEY!.length).toBeGreaterThanOrEqual(32);
    expect(env.PRESS_SECRET!.length).toBeGreaterThanOrEqual(32);
    expect(env.ADMIN_PASSWORD!.length).toBeGreaterThanOrEqual(12);
    expect(env.APP_DB_PASSWORD!.length).toBeGreaterThanOrEqual(16);
    expect(new Set(Object.values(env)).size).toBe(Object.keys(env).length);
  });

  it("the compose file publishes only on 127.0.0.1, with no renderer key", () => {
    const ports = [...COMPOSE_YML.matchAll(/^\s+- "([^"]+:\d+)"$/gm)].map((m) => m[1]!);
    expect(ports.length).toBe(2);
    for (const p of ports) expect(p.startsWith("127.0.0.1:")).toBe(true);
    expect(COMPOSE_YML).not.toMatch(/RENDERER_KEY|Renderer__Key/i);
    expect(COMPOSE_YML).not.toContain("Development");
  });

  it("core trusts the fixed Caddy address and nothing else", () => {
    const ip = /ipv4_address: (\S+)/.exec(COMPOSE_YML)![1];
    expect(COMPOSE_YML).toContain(`ForwardedHeaders__KnownProxies__0: ${ip}`);
    expect(COMPOSE_YML).toContain('ForwardedHeaders__Enabled: "true"');
    expect(COMPOSE_YML).not.toContain("KnownNetworks");
    expect(COMPOSE_YML).toContain("subnet: 172.28.0.0/24");
  });

  it("sets hosts, origins, tenant and raised limits", () => {
    expect(COMPOSE_YML).toContain('AllowedHosts: "api;api.localhost;admin.localhost;client.localhost;localhost;127.0.0.1"');
    expect(COMPOSE_YML).toContain("http://admin.localhost:${PORT},http://client.localhost:${PORT}");
    expect(COMPOSE_YML).toContain("CMS_TENANT: client");
    expect(COMPOSE_YML).toContain("Tenancy__Mode: Single");
    expect(COMPOSE_YML).toContain('NEXT_PUBLIC_API_URL: "http://admin.localhost:${PORT}"');
    for (const k of ["PermitLimit", "WindowSeconds", "QueueLimit"]) {
      expect(COMPOSE_YML).toContain(`RateLimiting__Global__${k}:`);
    }
  });

  it("runs the console read-only from a runtime directory on its tmpfs", () => {
    const console = COMPOSE_YML.slice(COMPOSE_YML.indexOf("\n  console:"), COMPOSE_YML.indexOf("\n  caddy:"));
    expect(console).toContain("image: ${BREW_IMAGE}");
    expect(console).toMatch(/^\s+read_only: true$/m);
    expect(console).toContain("- /tmp:mode=1777,size=128m");
    expect(console).toContain("BARAKO_RUNTIME_DIR: /tmp/barako-app");
    const brew = (JSON.parse(VERSIONS_JSON) as { brew: { tag: string } }).brew.tag.split(".").map(Number);
    expect(brew[0]! > 1 || (brew[0] === 1 && brew[1]! >= 14)).toBe(true);
  });

  it("Caddy routes the hosts as designed", () => {
    expect(CADDYFILE).toMatch(/http:\/\/client\.localhost:8080 \{\s+handle \/api\/public\/files\* \{\s+reverse_proxy api:8080 \{\s+header_up Host api\s+header_up X-Tenant client/);
    expect(CADDYFILE).not.toMatch(/handle \/files/);
    expect(CADDYFILE).toMatch(/http:\/\/admin\.localhost:8080 \{\s+handle \/health \{\s+reverse_proxy api:8080/);
    const admin = CADDYFILE.slice(CADDYFILE.indexOf("http://admin.localhost:8080"), CADDYFILE.indexOf("http://api.localhost:8080"));
    expect(admin).toMatch(/handle \/api\/public\/files\* \{\s+reverse_proxy api:8080 \{\s+header_up Host api\s+header_up X-Tenant client\s/);
    expect(CADDYFILE).toMatch(/handle \/api\/\* \{\s+reverse_proxy api:8080/);
    expect(CADDYFILE).toContain("reverse_proxy console:3000");
    expect(CADDYFILE).toContain("reverse_proxy site:3000");
    expect(CADDYFILE).toContain("http://api.localhost:8080");
  });

  it("every Caddy proxy to api sets a Host that core allows", () => {
    const allowed = /AllowedHosts: "([^"]+)"/.exec(COMPOSE_YML)![1]!.split(";");
    const blocks = [...CADDYFILE.matchAll(/reverse_proxy api:8080 \{([^}]*)\}/g)];
    const plain = [...CADDYFILE.matchAll(/reverse_proxy api:8080(?! \{)/g)];
    expect(plain).toEqual([]);
    expect(blocks.length).toBe(5);
    for (const b of blocks) {
      const host = /header_up Host (\S+)/.exec(b[1]!)?.[1];
      expect(allowed).toContain(host);
    }
    expect(allowed).toContain("client.localhost");
  });

  it("the site service has no SITE_URL", () => {
    expect(COMPOSE_YML).not.toContain("SITE_URL");
  });

  it("the site healthcheck asks for a path that renders no page", () => {
    // A check that renders the home page before the tenant exists caches a 404 for every visitor.
    const site = COMPOSE_YML.slice(COMPOSE_YML.indexOf("\n  site:"), COMPOSE_YML.indexOf("\n  console:"));
    const test = /healthcheck:\s+test: (\[.*\])/.exec(site)?.[1];
    expect(test, "the site service sets its own healthcheck").toBeDefined();
    const urls = [...test!.matchAll(/https?:\/\/[^'"\s)]+/g)].map((m) => new URL(m[0]).pathname);
    expect(urls).toEqual(["/api/health"]);
  });

  it("versions.json pins core 5.9.0 and gives each image a tag and digest", () => {
    const v = JSON.parse(VERSIONS_JSON);
    expect(v.core.tag).toBe("5.9.0");
    for (const k of ["core", "press", "brew", "postgres", "caddy"]) {
      expect(v[k].tag, k).toBeTruthy();
      expect(v[k].digest, k).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });
});

describe("docker calls", () => {
  it("up runs compose with an argument array, in order, and --wait", async () => {
    await cmd("up")({});
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(Array.isArray(c.args)).toBe(true);
      for (const a of c.args) expect(typeof a).toBe("string");
      expect(c.args).not.toContain("-c");
      expect(c.args[0]).not.toMatch(/\s/);
    }
    const up = calls.find((c) => c.args.includes("up"))!;
    expect(up.args).toEqual([
      "compose", "-p", "barako", "-f", join(dir(), "compose.yml"), "--env-file", join(dir(), ".env"), "up", "-d", "--wait", "--wait-timeout", "600",
    ]);
    expect(up.cwd).toBe(dir());
  });

  it("passes the port and image references, never a secret, in the docker environment", async () => {
    await cmd("up")({ port: 9393 });
    const up = calls.find((c) => c.args.includes("up"))!;
    expect(up.env!.PORT).toBe("9393");
    expect(up.env!.CORE_IMAGE).toMatch(/^ghcr\.io\/baryodev\/barako-cms:5\.9\.0@sha256:[0-9a-f]{64}$/);
    const secrets = readFileSync(join(dir(), ".env"), "utf8").trim().split("\n").map((l) => l.split("=")[1]!);
    for (const s of secrets) expect(JSON.stringify(up.env)).not.toContain(s);
  });

  it("the real runner spawns docker with an array and no shell", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    spawnMock.mockReturnValue(child);
    const p = realDeps().docker(["compose", "up", "; echo hacked"], { cwd: "/x", env: { PORT: "1" } });
    child.emit("close", 0);
    await p;
    const [bin, args, opts] = spawnMock.mock.calls[0]!;
    expect(bin).toBe("docker");
    expect(args).toEqual(["compose", "up", "; echo hacked"]);
    expect(opts.shell).toBe(false);
  });

  it("stops before writing when docker is missing", async () => {
    dockerMissing = true;
    const e = await fails(() => cmd("up")({}));
    expect(e.message).toContain("Docker is not installed");
    expect(existsSync(dir())).toBe(false);
  });

  it("stops before writing when compose is too old for --wait", async () => {
    composeVersion = "2.1.0";
    const e = await fails(() => cmd("up")({}));
    expect(e.message).toContain("too old");
    expect(existsSync(dir())).toBe(false);
  });
});

describe("up output", () => {
  it("prints URLs, the admin user, the password file and the mcp line, and no secret", async () => {
    const out = await cmd("up")({ port: 8081 });
    expect(out.urls.site).toBe("http://client.localhost:8081");
    expect(out.urls.console).toBe("http://admin.localhost:8081");
    expect(out.urls.apiLocal).toBe("http://127.0.0.1:5005");
    expect(out.adminUser).toBe("admin");
    expect(out.passwordFile).toBe(join(dir(), ".env"));
    expect(out.mcp).toBe(`barako mcp --allow-writes --url http://127.0.0.1:5005 --key-file ${join(dir(), "api-key")}`);
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
    const secrets = readFileSync(join(dir(), ".env"), "utf8").trim().split("\n").map((l) => l.split("=")[1]!);
    for (const s of secrets) expect(JSON.stringify(out)).not.toContain(s);
  });

  it("a second up on a running stack changes nothing and keeps .env", async () => {
    await cmd("up")({});
    const files = ["compose.yml", "Caddyfile", "app-role.sql", "versions.json", "state.json", ".env"];
    const before = files.map((f) => readFileSync(join(dir(), f), "utf8"));
    calls = [];
    running = 5;
    const out = await cmd("up")({});
    expect(out.alreadyRunning).toBe(true);
    expect(out.bootstrapped).toBe(false);
    expect(calls.some((c) => c.args.includes("up"))).toBe(false);
    expect(files.map((f) => readFileSync(join(dir(), f), "utf8"))).toEqual(before);
  });

  it("up with another port on a running stack refuses", async () => {
    await cmd("up")({});
    running = 5;
    const e = await fails(() => cmd("up")({ port: 9000 }));
    expect(e.code).toBe("conflict");
  });

  it("--latest uses the newest tags and says so", async () => {
    const out = await cmd("up")({ latest: true });
    expect(out.notice).toContain("newest");
    const up = calls.find((c) => c.args.includes("up"))!;
    expect(up.env!.CORE_IMAGE).toBe("ghcr.io/baryodev/barako-cms:latest");
    expect(up.env!.PRESS_IMAGE).toBe("ghcr.io/baryodev/barako-press:latest");
    expect(up.env!.BREW_IMAGE).toBe("ghcr.io/baryodev/barako-brew:latest");
  });
});

describe("a failed up", () => {
  it("prints no value from .env and no docker environment", async () => {
    await cmd("up")({});
    const secrets = readFileSync(join(dir(), ".env"), "utf8").trim().split("\n").map((l) => l.split("=")[1]!);
    upReply = {
      code: 1,
      stderr: `service api failed: JWT__Key=${secrets[2]} password ${secrets[1]} PORT=8080 CORE_IMAGE=x\nexit`,
    };
    const e = await fails(() => cmd("up")({}));
    expect(e.code).toBe("server");
    for (const s of secrets) expect(e.message).not.toContain(s);
    expect(e.message).toContain("docker compose up failed");
  });

  it("on a first failed up the message holds no secret either", async () => {
    upReply = { code: 1, stderr: "boom" };
    const e = await fails(() => cmd("up")({}));
    const secrets = readFileSync(join(dir(), ".env"), "utf8").trim().split("\n").map((l) => l.split("=")[1]!);
    for (const s of secrets) expect(e.message).not.toContain(s);
  });
});

describe("down and reset", () => {
  it("down keeps data: no --volumes", async () => {
    await cmd("up")({});
    calls = [];
    await cmd("down")();
    const d = calls.find((c) => c.args.includes("down"))!;
    expect(d.args).not.toContain("--volumes");
    expect(d.args).not.toContain("-v");
  });

  it("reset without --yes refuses when stdin is not a TTY", async () => {
    await cmd("up")({});
    calls = [];
    const e = await fails(() => cmd("reset")({}, { isTty: false }));
    expect(e.code).toBe("usage");
    expect(e.message).toContain("--yes");
    expect(calls).toEqual([]);
  });

  it("reset refuses when the TTY check is absent too", async () => {
    const e = await fails(() => cmd("reset")({}, {}));
    expect(e.message).toContain("--yes");
  });

  it("reset --yes drops the volumes without asking", async () => {
    await cmd("up")({});
    calls = [];
    const ask = vi.fn();
    const out = await cmd("reset")({ yes: true }, { isTty: false, ask });
    expect(ask).not.toHaveBeenCalled();
    expect(out.reset).toBe(true);
    expect(calls.find((c) => c.args.includes("down"))!.args).toContain("--volumes");
  });

  it("reset on a TTY asks and goes on only for yes", async () => {
    await cmd("up")({});
    calls = [];
    const no = await cmd("reset")({}, { isTty: true, ask: async () => "no" });
    expect(no.reset).toBe(false);
    expect(calls).toEqual([]);
    const yes = await cmd("reset")({}, { isTty: true, ask: async () => "yes" });
    expect(yes.reset).toBe(true);
  });

  it("main reads the TTY from Io: reset without --yes exits 1 when it is false", async () => {
    const out: string[] = [];
    const code = await run(["reset"], {}, { readFile: () => "", write: (_s, t) => void out.push(t), isTTY: false });
    expect(code).toBe(1);
    expect(out.join("")).toContain("--yes");
  });
});

describe("status", () => {
  it("reports an unconfigured stack without calling docker", async () => {
    const out = await cmd("status")();
    expect(out).toEqual({ configured: false, running: false });
    expect(calls).toEqual([]);
  });

  it("lists services from compose ps", async () => {
    await cmd("up")({});
    const deps = fakeDeps();
    const orig = deps.docker;
    deps.docker = async (args, opts) =>
      args.includes("ps") && args.includes("--all")
        ? { code: 0, stderr: "", stdout: '{"Service":"api","State":"running","Health":"healthy"}\n{"Service":"site","State":"exited"}\n' }
        : orig(args, opts);
    const c = makeStackCommands(deps).find((x) => x.name === "status")!;
    const out = (await c.run({ client: {} as never, readFile: () => "" }, {})) as Record<string, any>;
    expect(out.running).toBe(false);
    expect(out.services).toEqual([
      { service: "api", state: "running", health: "healthy" },
      { service: "site", state: "exited" },
    ]);
  });
});

const SECRET_KEYS = ["DB_PASSWORD", "APP_DB_PASSWORD", "JWT_KEY", "PRESS_SECRET", "ADMIN_PASSWORD"];

function fakeChild(code: number) {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  setTimeout(() => child.emit("close", code), 0);
  return child;
}

describe("docker version", () => {
  it.each(["2.40.3-desktop.1", "v2.24.0", "2.40.3-rc.1", "5.2.0", "2.17.0"])("accepts %s", async (v) => {
    composeVersion = v;
    await cmd("up")({});
    expect(calls.some((c) => c.args.includes("up"))).toBe(true);
  });

  it("refuses text that is not a version", async () => {
    composeVersion = "garbage";
    const e = await fails(() => cmd("up")({}));
    expect(e.message).toContain("Could not read");
    expect(existsSync(dir())).toBe(false);
  });

  it.each(["2.16.9", "1.29.2", "2.9.0-desktop.1"])("refuses %s as too old", async (v) => {
    composeVersion = v;
    const e = await fails(() => cmd("up")({}));
    expect(e.message).toContain("too old");
  });
});

describe("docker environment", () => {
  it("drops exported secret names and lets the compose values win", () => {
    const env = dockerEnv(
      { JWT_KEY: "from-shell", DB_PASSWORD: "x", PATH: "/bin", PORT: "1" },
      { PORT: "8080", CORE_IMAGE: "img" },
    );
    expect(env.JWT_KEY).toBeUndefined();
    expect(env.DB_PASSWORD).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    expect(env.PORT).toBe("8080");
  });

  it("the real runner passes no exported secret to spawn", async () => {
    process.env.JWT_KEY = "shell-value-not-real";
    try {
      spawnMock.mockReturnValue(fakeChild(0));
      await realDeps().docker(["compose", "ps"], { env: { PORT: "1" } });
      expect(spawnMock.mock.calls[0]![2].env.JWT_KEY).toBeUndefined();
    } finally {
      delete process.env.JWT_KEY;
    }
  });
});

describe("a half-made stack", () => {
  it("up stops when .env is gone and state.json remains", async () => {
    await cmd("up")({});
    rmSync(join(dir(), ".env"));
    const e = await fails(() => cmd("up")({}));
    expect(e.message).toContain("barako reset");
  });

  it("up stops when .env is gone and the volume remains", async () => {
    volume = true;
    const e = await fails(() => cmd("up")({}));
    expect(e.message).toContain("barako reset");
    expect(existsSync(join(dir(), ".env"))).toBe(false);
  });

  it("up stops when .env lacks a key or is empty", async () => {
    await cmd("up")({});
    writeFileSync(join(dir(), ".env"), "DB_PASSWORD=a\n", { mode: 0o600 });
    expect((await fails(() => cmd("up")({}))).message).toContain("barako reset");
    writeFileSync(join(dir(), ".env"), "", { mode: 0o600 });
    expect((await fails(() => cmd("up")({}))).message).toContain("barako reset");
  });

  it("reset with .env gone removes containers by label and the volume", async () => {
    await cmd("up")({});
    rmSync(join(dir(), ".env"));
    volume = true;
    labelled = "c1\nc2\n";
    calls = [];
    const out = await cmd("reset")({ yes: true });
    expect(out.reset).toBe(true);
    const argv = calls.map((c) => c.args.join(" "));
    expect(argv).toContain("rm -f c1 c2");
    expect(argv).toContain("volume rm barako_pgdata");
    expect(existsSync(join(dir(), "state.json"))).toBe(false);
  });

  it("reset with no state.json removes the volume", async () => {
    volume = true;
    const out = await cmd("reset")({ yes: true });
    expect(out.reset).toBe(true);
    expect(calls.map((c) => c.args.join(" "))).toContain("volume rm barako_pgdata");
  });

  it("reset with nothing set up says so before it asks", async () => {
    const ask = vi.fn();
    const out = await cmd("reset")({}, { isTty: true, ask });
    expect(out.reset).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe(".env", () => {
  it("is created through a link and leaves no .env.tmp", async () => {
    await cmd("up")({});
    expect(existsSync(join(dir(), ".env.tmp"))).toBe(false);
    const text = readFileSync(join(dir(), ".env"), "utf8");
    for (const k of SECRET_KEYS) expect(text).toContain(`${k}=`);
  });

  it("an existing .env is made 0600 again on a running stack too", async () => {
    await cmd("up")({});
    chmodSync(join(dir(), ".env"), 0o644);
    running = 5;
    const out = await cmd("up")({});
    expect(out.alreadyRunning).toBe(true);
    expect(statSync(join(dir(), ".env")).mode & 0o777).toBe(0o600);
  });

  it("an existing .env is made 0600 again", async () => {
    await cmd("up")({});
    chmodSync(join(dir(), ".env"), 0o644);
    await cmd("up")({});
    expect(statSync(join(dir(), ".env")).mode & 0o777).toBe(0o600);
  });

  it("reads export prefixes and quotes", async () => {
    await cmd("up")({});
    const quoted = SECRET_KEYS.map((k, i) => (i % 2 ? `export ${k}="v${i}x"` : `${k}='v${i}x'`)).join("\n");
    writeFileSync(join(dir(), ".env"), quoted + "\n", { mode: 0o600 });
    upReply = { code: 1, stderr: "leak v0x v1x" };
    const e = await fails(() => cmd("up")({}));
    expect(e.message).not.toContain("v0x");
    expect(e.message).not.toContain("v1x");
  });
});

describe("running states", () => {
  it.each([1, 2, 3, 4])("with %i services up, up goes on and keeps the settings", async (n) => {
    await cmd("up")({ latest: true });
    running = n;
    calls = [];
    const out = await cmd("up")({});
    expect(out.alreadyRunning).toBe(false);
    const up = calls.find((c) => c.args.includes("up"))!;
    expect(up.env!.CORE_IMAGE).toBe("ghcr.io/baryodev/barako-cms:latest");
    expect(up.args).toContain("--pull");
  });

  it("a partial stack at latest refuses an explicit change", async () => {
    await cmd("up")({ latest: true });
    running = 2;
    expect((await fails(() => cmd("up")({ port: 9000 }))).code).toBe("conflict");
  });

  it("a stopped latest stack comes back pinned without the flag", async () => {
    await cmd("up")({ latest: true });
    running = 0;
    calls = [];
    await cmd("up")({});
    const up = calls.find((c) => c.args.includes("up"))!;
    expect(up.env!.CORE_IMAGE).toContain("5.9.0");
    expect(up.args).not.toContain("--pull");
  });

  it("--latest passes --pull always and --wait-timeout", async () => {
    await cmd("up")({ latest: true });
    const up = calls.find((c) => c.args.includes("up"))!;
    expect(up.args.join(" ")).toContain("--pull always");
    expect(up.args.join(" ")).toContain("--wait-timeout 600");
  });

  it("up tells stderr that images are pulled", async () => {
    const log = vi.fn();
    await cmd("up")({}, { stdio: { input: [], write: () => {}, log } });
    expect(log.mock.calls[0]![0]).toContain("minutes");
  });

  it("a failing ps stops up instead of counting zero", async () => {
    await cmd("up")({});
    psFails = true;
    const e = await fails(() => cmd("up")({}));
    expect(e.message).toContain("docker compose ps failed");
  });

  it("a corrupt state.json stops up, status, down and reset-less commands", async () => {
    await cmd("up")({});
    writeFileSync(join(dir(), "state.json"), "{not json");
    for (const name of ["up", "status", "down"]) {
      const e = await fails(() => cmd(name)({}));
      expect(e.message, name).toContain("state.json is unreadable");
      expect(e.message, name).toContain("barako reset");
    }
  });

  it("reset repairs a corrupt state.json", async () => {
    await cmd("up")({});
    writeFileSync(join(dir(), "state.json"), "{}");
    const out = await cmd("reset")({ yes: true });
    expect(out.reset).toBe(true);
    expect(existsSync(join(dir(), "state.json"))).toBe(false);
  });

  it("a running stack with newer embedded files gets a notice", async () => {
    await cmd("up")({});
    writeFileSync(join(dir(), "Caddyfile"), "old\n");
    running = 5;
    const out = await cmd("up")({});
    expect(out.alreadyRunning).toBe(true);
    expect(out.notice).toContain("barako down");
  });
});

describe("the port at the CLI", () => {
  it.each(["0x1F90", "1e4", " 8080", "8080.0", "5005", "80"])("run up --port %s is a usage error", async (v) => {
    const out: string[] = [];
    const code = await run(["up", "--port", v], {}, { readFile: () => "", write: (_s, t) => void out.push(t) });
    expect(code).toBe(1);
    expect(out.join("")).toContain("--port");
    expect(calls).toEqual([]);
  });
});

describe("reset through main", () => {
  let oldHome: string | undefined;
  beforeEach(() => {
    oldHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  });

  async function setUp() {
    await cmd("up")({});
    spawnMock.mockImplementation(() => fakeChild(0));
  }

  it("a TTY and an answer of no does not confirm", async () => {
    await setUp();
    const out: string[] = [];
    const code = await run(
      ["reset"],
      {},
      { readFile: () => "", write: (_s, t) => void out.push(t), isTTY: true, ask: async () => "no" },
    );
    expect(code).toBe(0);
    expect(out.join("")).toContain("not confirmed");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("a TTY and an answer of yes goes on", async () => {
    await setUp();
    const out: string[] = [];
    const code = await run(
      ["reset"],
      {},
      { readFile: () => "", write: (_s, t) => void out.push(t), isTTY: true, ask: async () => "yes" },
    );
    expect(code).toBe(0);
    expect(out.join("")).toContain('"reset":true');
    expect(spawnMock.mock.calls[0]![1]).toContain("--volumes");
  });
});

const paths = () => httpCalls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
const header = (c: HttpRequest, name: string) => c.headers?.[name];

describe("bootstrap", () => {
  it("signs in, makes the tenant, signs in as it, applies the kit and makes the key, in that order", async () => {
    await cmd("up")({});
    expect(paths()).toEqual([
      "GET /health/ready",
      "POST /api/auth/login",
      "POST /api/tenants",
      "POST /api/auth/login",
      "POST /api/content-types/blueprints/site",
      "POST /api/content-types/blueprints/blog",
      "POST /api/api-keys",
    ]);
    const [, login1, tenant, login2, blueprint, , key] = httpCalls as HttpRequest[] as [HttpRequest, HttpRequest, HttpRequest, HttpRequest, HttpRequest, HttpRequest, HttpRequest];
    const env = readFileSync(join(dir(), ".env"), "utf8");
    const password = /ADMIN_PASSWORD=(.*)/.exec(env)![1];
    expect(login1.json).toEqual({ Username: "admin", Password: password });
    expect(header(login1, "x-tenant")).toBeUndefined();
    expect(header(tenant, "authorization")).toBe(`Bearer ${FAKE_JWT}`);
    expect(tenant.json).toMatchObject({ Handle: "client" });
    expect(header(login2, "x-tenant")).toBe("client");
    expect(header(blueprint, "x-tenant")).toBe("client");
    expect(key.json).toMatchObject({
      Name: "barako up",
      Scopes: ["content:read", "content:write"],
      ContentTypes: [],
      ReadOnly: false,
    });
    const expires = Date.parse((key.json as { ExpiresAt: string }).ExpiresAt);
    expect(expires).toBeGreaterThan(Date.now() + 300 * 24 * 3600 * 1000);
    for (const c of httpCalls) expect(c.url.startsWith("http://127.0.0.1:5005/")).toBe(true);
  });

  it("writes the key as 0600 through a link, and never prints it", async () => {
    const oldMask = process.umask(0o022);
    try {
      const out = await cmd("up")({});
      const file = join(dir(), "api-key");
      expect(readFileSync(file, "utf8")).toBe(FAKE_KEY + "\n");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(existsSync(join(dir(), "api-key.tmp"))).toBe(false);
      expect(out.apiKeyFile).toBe(file);
      expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
    } finally {
      process.umask(oldMask);
    }
  });

  it("a second up on a running stack signs in no more and keeps the key", async () => {
    await cmd("up")({});
    const key = readFileSync(join(dir(), "api-key"), "utf8");
    httpCalls = [];
    running = 5;
    const out = await cmd("up")({});
    expect(out.alreadyRunning).toBe(true);
    expect(out.bootstrapped).toBe(false);
    // One cheap key check, no sign-in and no new key.
    expect(paths()).toEqual(["GET /api/content-types"]);
    expect(header(httpCalls[0]!, "authorization")).toBe(`Bearer ${FAKE_KEY}`);
    expect(readFileSync(join(dir(), "api-key"), "utf8")).toBe(key);
    expect(out.mcp).toContain("--key-file");
  });

  it("up after down does not sign in again either", async () => {
    await cmd("up")({});
    httpCalls = [];
    running = 0;
    const out = await cmd("up")({});
    expect(paths()).toEqual(["GET /api/content-types"]);
    expect(out.bootstrapped).toBe(false);
  });

  it("a key that core refuses (401) is replaced without a new tenant", async () => {
    await cmd("up")({});
    api = (r) => (new URL(r.url).pathname === "/api/content-types" && r.method === "GET" ? { status: 401, body: "" } : happyApi(r));
    httpCalls = [];
    running = 5;
    const out = await cmd("up")({});
    expect(out.bootstrapped).toBe(true);
    expect(paths()).not.toContain("POST /api/tenants");
    expect(paths()).toContain("POST /api/api-keys");
    expect(out.notice).toContain("new API key");
  });

  it("an API that does not answer the key check is an error, not a new key", async () => {
    await cmd("up")({});
    api = (r) => (new URL(r.url).pathname === "/api/content-types" ? { status: 0, body: "" } : happyApi(r));
    httpCalls = [];
    running = 5;
    const e = await fails(() => cmd("up")({}));
    expect(e.code).toBe("network");
    expect(paths()).not.toContain("POST /api/api-keys");
  });

  it("makes no second key when the key file is there", async () => {
    await cmd("up")({});
    const state = JSON.parse(readFileSync(join(dir(), "state.json"), "utf8"));
    delete state.bootstrap;
    writeFileSync(join(dir(), "state.json"), JSON.stringify(state), { mode: 0o600 });
    httpCalls = [];
    running = 5;
    const out = await cmd("up")({});
    expect(out.notice).toContain("earlier barako up");
    expect(out.notice).toContain("365 days");
    expect(paths()).not.toContain("POST /api/api-keys");
    expect(paths()).toContain("POST /api/content-types/blueprints/blog");
    expect(readFileSync(join(dir(), "api-key"), "utf8")).toBe(FAKE_KEY + "\n");
  });

  it("goes on when the tenant already exists, and stops on any other 400", async () => {
    api = (r) =>
      new URL(r.url).pathname === "/api/tenants"
        ? { status: 400, body: JSON.stringify({ errors: { handle: ["A tenant with this handle already exists."] } }) }
        : happyApi(r);
    await cmd("up")({});
    expect(paths()).toContain("POST /api/api-keys");

    rmSync(dir(), { recursive: true, force: true });
    api = (r) => (new URL(r.url).pathname === "/api/tenants" ? { status: 400, body: "LEAKED-BODY" } : happyApi(r));
    const e = await fails(() => cmd("up")({}));
    expect(e.message).toContain("HTTP 400");
    expect(e.message).not.toContain("LEAKED-BODY");
  });

  it("a 409 on the tenant is a domain clash", async () => {
    api = (r) => (new URL(r.url).pathname === "/api/tenants" ? { status: 409, body: "LEAKED-BODY" } : happyApi(r));
    const e = await fails(() => cmd("up")({}));
    expect(e.code).toBe("conflict");
    expect(e.message).not.toContain("LEAKED-BODY");
    expect(existsSync(join(dir(), "api-key"))).toBe(false);
  });

  const already = (name: string) =>
    JSON.stringify({ errors: { blueprint: [`Blueprint '${name}' was not applied: post already exists in this tenant. Applying is additive and never replaces a type.`] } });
  const onKit = (reply: HttpReply | ((name: string) => HttpReply)) => (r: HttpRequest): HttpReply => {
    const m = /^\/api\/content-types\/blueprints\/(.+)$/.exec(new URL(r.url).pathname);
    return m ? (typeof reply === "function" ? reply(m[1]!) : reply) : happyApi(r);
  };

  it("a kit that already exists in the tenant (409 with core's text) is fine", async () => {
    api = onKit((n) => ({ status: 409, body: already(n) }));
    await cmd("up")({});
    expect(existsSync(join(dir(), "api-key"))).toBe(true);
  });

  it("a 409 that names another kit is not taken for this kit's", async () => {
    api = onKit({ status: 409, body: already("other") });
    const e = await fails(() => cmd("up")({}));
    expect(e.code).toBe("conflict");
    expect(e.message).toContain("'site'");
  });

  it("any other 409 on a kit is a conflict, with core's reasons and no raw body", async () => {
    api = onKit({ status: 409, body: JSON.stringify({ errors: { name: ["The name 'post' is held by an earlier type.\u0007"] }, trace: "LEAKED-BODY" }) });
    const e = await fails(() => cmd("up")({}));
    expect(e.code).toBe("conflict");
    expect(e.message).toContain("held by an earlier type");
    expect(e.message).not.toContain("LEAKED-BODY");
    // eslint-disable-next-line no-control-regex
    expect(e.message).not.toMatch(/[\u0000-\u001f]/);
    expect(existsSync(join(dir(), "api-key"))).toBe(false);
  });

  it("an unknown kit (404) is an error", async () => {
    api = onKit({ status: 404, body: "LEAKED-BODY" });
    const e = await fails(() => cmd("up")({}));
    expect(e.code).toBe("not_found");
    expect(e.message).not.toContain("LEAKED-BODY");
  });

  it("a failed up leaves no marker, so the next up tries the whole bootstrap again", async () => {
    api = onKit({ status: 500, body: "" });
    await fails(() => cmd("up")({}));
    expect(JSON.parse(readFileSync(join(dir(), "state.json"), "utf8")).bootstrap).toBeUndefined();
    api = happyApi;
    running = 5;
    httpCalls = [];
    const out = await cmd("up")({});
    expect(out.bootstrapped).toBe(true);
    expect(paths()).toContain("POST /api/api-keys");
  });

  it("the marker holds the kit and, for a file, its hash", async () => {
    await cmd("up")({});
    expect(JSON.parse(readFileSync(join(dir(), "state.json"), "utf8")).bootstrap).toEqual({ kit: "blog" });
  });

  it("signs in once and does not retry on a refusal", async () => {
    for (const status of [401, 429, 500]) {
      rmSync(dir(), { recursive: true, force: true });
      httpCalls = [];
      api = (r) => (new URL(r.url).pathname === "/api/auth/login" ? { status, body: "LEAKED-BODY" } : happyApi(r));
      const e = await fails(() => cmd("up")({}));
      expect(httpCalls.filter((c) => c.url.endsWith("/api/auth/login"))).toHaveLength(1);
      expect(e.message).not.toContain("LEAKED-BODY");
      if (status === 429) {
        expect(e.message).toContain("15 minutes");
        expect(e.code).toBe("server");
      }
    }
  });

  it("a refused tenant sign-in says so, apart from a wrong password", async () => {
    let logins = 0;
    api = (r) => {
      if (new URL(r.url).pathname === "/api/auth/login" && ++logins === 2) return { status: 401, body: "LEAKED-BODY" };
      return happyApi(r);
    };
    const e = await fails(() => cmd("up")({}));
    expect(e.code).toBe("unauthorized");
    expect(e.message).toContain("tenant client");
    expect(e.message).not.toContain("password in .env");
    expect(e.message).not.toContain("LEAKED-BODY");
  });

  it("no failing path puts the admin password in its message", async () => {
    for (const path of ["/health/ready", "/api/auth/login", "/api/tenants", "/api/content-types/blueprints/blog", "/api/api-keys"]) {
      rmSync(dir(), { recursive: true, force: true });
      api = (r) => (new URL(r.url).pathname === path ? { status: 500, body: "x" } : happyApi(r));
      const e = await fails(() => cmd("up")({}));
      const password = /ADMIN_PASSWORD=(.*)/.exec(readFileSync(join(dir(), ".env"), "utf8"))![1]!;
      expect(e.message, path).not.toContain(password);
    }
  });

  it("no error holds the admin password or a response body", async () => {
    api = (r) => (new URL(r.url).pathname === "/api/api-keys" ? { status: 500, body: "LEAKED-BODY" } : happyApi(r));
    const e = await fails(() => cmd("up")({}));
    const password = /ADMIN_PASSWORD=(.*)/.exec(readFileSync(join(dir(), ".env"), "utf8"))![1]!;
    expect(e.message).not.toContain(password);
    expect(e.message).not.toContain("LEAKED-BODY");
    expect(e.message).toContain("HTTP 500");
  });

  it("a key reply with no key is an error and leaves no key file", async () => {
    api = (r) => (new URL(r.url).pathname === "/api/api-keys" ? { status: 200, body: "{}" } : happyApi(r));
    await fails(() => cmd("up")({}));
    expect(existsSync(join(dir(), "api-key"))).toBe(false);
  });

  it("an API that never gets ready is an error", async () => {
    api = () => ({ status: 503, body: "" });
    const e = await fails(() => cmd("up")({}));
    expect(e.code).toBe("network");
    expect(e.message).toContain("90 seconds");
    expect(httpCalls.length).toBe(90);
    expect(httpCalls.every((c) => (c.timeoutMs ?? 0) <= 5000)).toBe(true);
  });

  it("reset removes the key and the marker, so the next up starts over", async () => {
    await cmd("up")({});
    await cmd("reset")({ yes: true });
    expect(existsSync(join(dir(), "api-key"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir(), "state.json"), "utf8")).bootstrap).toBeUndefined();
    httpCalls = [];
    await cmd("up")({});
    expect(paths()).toContain("POST /api/api-keys");
  });
});

describe("kit", () => {
  const file = (text: string, name = "kit.json") => {
    const p = join(home, name);
    writeFileSync(p, text);
    return p;
  };

  it("takes a name that is lower-case words joined by single hyphens", () => {
    expect(resolveKit("site")).toEqual({ name: "site" });
    expect(resolveKit("my-kit-2")).toEqual({ name: "my-kit-2" });
    expect(resolveKit(undefined)).toBeUndefined();
  });

  it("refuses a name with a slash, dots, an escape, a line feed or the wrong shape", () => {
    for (const bad of ["a/b", "..", "../site", "%2F", "a%2Fb", "site\n", "\nsite", "site\r\n", "Site", "-site", "site-", "a--b", "a b", ""]) {
      expect(() => resolveKit(bad), JSON.stringify(bad)).toThrow(/--kit/);
    }
    expect(() => resolveKit(5)).toThrow(/--kit/);
  });

  it("up refuses a bad kit before it starts docker", async () => {
    const e = await fails(() => cmd("up")({ kit: "a/b" }));
    expect(e.code).toBe("usage");
    expect(calls).toEqual([]);
    expect(httpCalls).toEqual([]);
  });

  it("reads a path as text and takes its name from the file", () => {
    const text = JSON.stringify({ name: " Press-Kit ", contentTypes: [] });
    const got = resolveKit(file(text))!;
    expect(got).toMatchObject({ name: "press-kit", file: text });
    expect(got.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a path that is not JSON, has no usable name, is a folder or is too large", () => {
    expect(() => resolveKit(file("module.exports = 1;"))).toThrow(/plain JSON/);
    expect(() => resolveKit(file("{}"))).toThrow(/"name"/);
    expect(() => resolveKit(file(JSON.stringify({ name: "Bad Name" })))).toThrow(/"name"/);
    expect(() => resolveKit(home)).toThrow(/--kit/);
    expect(() => resolveKit(file(JSON.stringify({ name: "big", pad: "x".repeat(300 * 1024) })))).toThrow(/256 KB/);
  });

  it("strips a byte order mark and refuses a name that is a built-in kit", () => {
    expect(resolveKit(file("\uFEFF" + JSON.stringify({ name: "mine" })))!.name).toBe("mine");
    for (const n of ["blog", "devsite", "docs", "email", "events", "portfolio", "site", "Blog"]) {
      expect(() => resolveKit(file(JSON.stringify({ name: n }))), n).toThrow(/built-in/);
    }
  });

  it("the blueprints folder and the kit file can be read by core, the secrets stay 0600", async () => {
    const oldMask = process.umask(0o077);
    try {
      await cmd("up")({ kit: file(JSON.stringify({ name: "mine" })) });
      expect(statSync(join(dir(), "blueprints")).mode & 0o777).toBe(0o755);
      expect(statSync(join(dir(), "blueprints", "mine.json")).mode & 0o777).toBe(0o644);
      expect(statSync(join(dir(), ".env")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir(), "api-key")).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(oldMask);
    }
  });

  it("an edited kit file is applied again with a notice, without a new key or tenant", async () => {
    const path = file(JSON.stringify({ name: "mine", v: 1 }));
    await cmd("up")({ kit: path });
    httpCalls = [];
    running = 5;
    writeFileSync(path, JSON.stringify({ name: "mine", v: 2 }));
    const out = await cmd("up")({ kit: path });
    expect(out.bootstrapped).toBe(true);
    expect(out.notice).toContain("kit file changed");
    expect(paths()).toContain("POST /api/content-types/blueprints/mine");
    expect(paths()).not.toContain("POST /api/api-keys");
    expect(paths()).not.toContain("POST /api/tenants");
  });

  it("applies a named kit, encoded in the path", async () => {
    await cmd("up")({ kit: "blog-2" });
    expect(paths()).toContain("POST /api/content-types/blueprints/blog-2");
  });

  it("copies a kit file into the stack folder and applies it by its name", async () => {
    const text = JSON.stringify({ name: "mine", contentTypes: [] });
    await cmd("up")({ kit: file(text) });
    expect(readFileSync(join(dir(), "blueprints", "mine.json"), "utf8")).toBe(text);
    expect(paths()).toContain("POST /api/content-types/blueprints/site");
    expect(paths()).toContain("POST /api/content-types/blueprints/mine");
    expect(COMPOSE_YML).toContain("./blueprints:/blueprints:ro");
    expect(COMPOSE_YML).toContain("Blueprints__Path: /blueprints");
  });

  it("applies another kit on a running stack without a second key", async () => {
    await cmd("up")({});
    httpCalls = [];
    running = 5;
    await cmd("up")({ kit: "other" });
    expect(paths()).toContain("POST /api/content-types/blueprints/other");
    expect(paths()).not.toContain("POST /api/api-keys");
  });
});

describe("services after up", () => {
  it("names the services that are not running after compose up returns", async () => {
    runningAfterUp = 3;
    const e = await fails(() => cmd("up")({}));
    expect(e.code).toBe("server");
    expect(e.message).toContain("console, caddy");
    expect(httpCalls).toEqual([]);
  });

  it("asks compose for service names, not a count of ids", async () => {
    await cmd("up")({});
    const ps = calls.find((c) => c.args.includes("ps"))!;
    expect(ps.args).toEqual(expect.arrayContaining(["--services", "--status", "running"]));
  });

  it("a stack with a service down is not alreadyRunning, even with five lines of output", async () => {
    await cmd("up")({});
    running = 4;
    const out = await cmd("up")({});
    expect(out.alreadyRunning).toBe(false);
  });
});

describe("services staying up", () => {
  const inspects = () => calls.filter((c) => c.args[0] === "inspect");
  const flapping = (service: string, every: number) => (at: number) =>
    steady().map((b) =>
      b.service === service
        ? { ...b, status: at % every < 1000 ? "running" : "restarting", restarts: Math.floor(at / every), started: Math.floor(at / every) * every }
        : b,
    );
  const firstSecret = () => readFileSync(join(dir(), ".env"), "utf8").split("\n")[0]!.split("=")[1]!;

  it("returns once every service has run 10 seconds with no restart", async () => {
    const out = await cmd("up")({});
    expect(out.alreadyRunning).toBe(false);
    expect(clock).toBeGreaterThanOrEqual(10_000);
    expect(clock).toBeLessThan(12_000);
  });

  it("asks inspect for the service, state, restart count, start time and name only, never the environment", async () => {
    await cmd("up")({});
    expect(inspects().length).toBeGreaterThan(0);
    for (const c of inspects()) {
      expect(c.args[1]).toBe("--format");
      expect(c.args[2]).toBe('{{index .Config.Labels "com.docker.compose.service"}} {{.State.Status}} {{.RestartCount}} {{.State.StartedAt}} {{.Name}}');
    }
  });

  it("fails up and names a service that keeps restarting", async () => {
    boxes = flapping("console", 3000);
    const e = await fails(() => cmd("up")({}));
    expect(e.code).toBe("server");
    expect(e.message).toMatch(/did not stay running: console \((running|restarting), restarted \d+ times\)\./);
    expect(e.message).toContain("docker logs barako-console-1");
    for (const other of ["postgres", "api", "site", "caddy"]) expect(e.message).not.toContain(other);
  });

  it("gives up after 60 seconds on the clock it is given", async () => {
    boxes = flapping("console", 3000);
    await fails(() => cmd("up")({}));
    expect(clock).toBeGreaterThanOrEqual(60_000);
    expect(clock).toBeLessThan(62_000);
  });

  it("a service that restarted once and then stays up passes, 10 seconds after its last restart", async () => {
    boxes = (at) => steady().map((b) => (b.service === "site" && at >= 3000 ? { ...b, restarts: 1 } : b));
    const out = await cmd("up")({});
    expect(out.alreadyRunning).toBe(false);
    expect(clock).toBeGreaterThanOrEqual(13_000);
  });

  it("a service that is not running when sampled is not steady", async () => {
    boxes = () => steady().map((b) => (b.service === "caddy" ? { ...b, status: "exited" } : b));
    const e = await fails(() => cmd("up")({}));
    expect(e.message).toContain("caddy (exited, restarted 0 times)");
  });

  it("the bootstrap time counts toward the 10 seconds", async () => {
    let tries = 0;
    api = (req) => (new URL(req.url).pathname === "/health/ready" && ++tries <= 12 ? { status: 503, body: "" } : happyApi(req));
    await cmd("up")({});
    // waitReady slept 12 seconds and the stack held still, so up adds no wait of its own.
    expect(clock).toBe(12_000);
  });

  it("a second up on a running stack does not wait when every service started 10 seconds ago or more", async () => {
    await cmd("up")({});
    calls = [];
    running = 5;
    const before = clock;
    const out = await cmd("up")({});
    expect(out.alreadyRunning).toBe(true);
    expect(inspects()).toHaveLength(1);
    expect(clock).toBe(before);
  });

  it("a second up fails when ps sees all five but the console started 2 seconds ago and keeps restarting", async () => {
    await cmd("up")({});
    running = 5;
    boxes = (at) => steady().map((b) => (b.service === "console" ? { ...b, restarts: Math.floor(at / 3000), started: at - 2000 } : b));
    const e = await fails(() => cmd("up")({}));
    expect(e.code).toBe("server");
    expect(e.message).toMatch(/did not stay running: console \(running, restarted \d+ times\)\./);
    for (const other of ["postgres", "api", "site", "caddy"]) expect(e.message).not.toContain(other);
  });

  it("after a first up fails on a looping console, a second up that catches it running fails too", async () => {
    boxes = flapping("console", 3000);
    expect((await fails(() => cmd("up")({}))).message).toContain("did not stay running: console");
    // The first up got as far as the key, so this one takes the already running path.
    expect(existsSync(join(dir(), "api-key"))).toBe(true);
    running = 5;
    const e = await fails(() => cmd("up")({}));
    expect(e.message).toContain("did not stay running: console");
  });

  it("an inspect that fails once counts as movement, and a steady stack then passes", async () => {
    inspectFails = (n) => (n === 3 ? "Error: No such object: id-console" : undefined);
    const out = await cmd("up")({});
    expect(out.alreadyRunning).toBe(false);
    // The third call failed at 1 second and the next good sample, at 2 seconds, starts the 10.
    expect(clock).toBeGreaterThanOrEqual(12_000);
  });

  it("an inspect that keeps failing ends at 60 seconds with its error, scrubbed of .env values", async () => {
    inspectFails = () => `Error: No such object: ${firstSecret()}`;
    const e = await fails(() => cmd("up")({}));
    expect(e.code).toBe("server");
    expect(e.message).toContain("Could not check that the services stay running");
    expect(e.message).toContain("docker inspect failed (docker exit 1)");
    expect(e.message).toContain("No such object");
    expect(e.message).not.toContain(firstSecret());
    expect(clock).toBeGreaterThanOrEqual(60_000);
    expect(clock).toBeLessThan(62_000);
  });

  it("a service missing from the inspect rows fails at 60 seconds and is named", async () => {
    boxes = () => steady().filter((b) => b.service !== "caddy");
    const e = await fails(() => cmd("up")({}));
    expect(e.message).toContain("did not stay running: caddy (no container)");
    expect(e.message).toContain("docker logs barako-caddy-1");
    expect(clock).toBeGreaterThanOrEqual(60_000);
    expect(clock).toBeLessThan(62_000);
  });

  it("empty lines in the inspect output are ignored", async () => {
    inspectBlank = true;
    const out = await cmd("up")({});
    expect(out.alreadyRunning).toBe(false);
    expect(clock).toBeLessThan(12_000);
  });
});

describe("createPrivateFile", () => {
  it("refuses to replace a file that is there, and says so as a conflict", () => {
    const d = mkdtempSync(join(tmpdir(), "barako-cpf-"));
    try {
      createPrivateFile(d, "api-key", "first\n");
      let err: { code?: string; message?: string } = {};
      try {
        createPrivateFile(d, "api-key", "second\n");
      } catch (e) {
        err = e as typeof err;
      }
      expect(err.code).toBe("conflict");
      expect(readFileSync(join(d, "api-key"), "utf8")).toBe("first\n");
      expect(existsSync(join(d, "api-key.tmp"))).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("the real http", () => {
  it("sends json, headers and a method, does not follow a redirect and reads the body", async () => {
    const seen: { method?: string; auth?: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, auth: req.headers.authorization, body });
        if (req.url === "/redirect") {
          res.writeHead(302, { location: "/elsewhere" });
          res.end();
        } else {
          res.writeHead(201);
          res.end("hello");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const http = realDeps().http;
      const ok = await http({ method: "POST", url: `http://127.0.0.1:${port}/a`, json: { x: 1 }, headers: { authorization: "Bearer t" } });
      expect(ok).toEqual({ status: 201, body: "hello" });
      expect(seen[0]).toEqual({ method: "POST", auth: "Bearer t", body: '{"x":1}' });
      const moved = await http({ method: "GET", url: `http://127.0.0.1:${port}/redirect` });
      expect(moved.status).toBe(302);
      expect(seen).toHaveLength(2);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("answers status 0 when nothing listens, and when the request is too slow", async () => {
    const http = realDeps().http;
    expect((await http({ method: "GET", url: "http://127.0.0.1:1/x" })).status).toBe(0);
    const server = createServer(() => {});
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      expect((await http({ method: "GET", url: `http://127.0.0.1:${port}/`, timeoutMs: 100 })).status).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});
