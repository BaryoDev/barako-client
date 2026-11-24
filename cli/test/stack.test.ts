import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { run } from "../src/main";
import { commands } from "../src/registry";
import {
  makeStackCommands,
  parsePort,
  realDeps,
  type DockerResult,
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

function fakeDeps(): StackDeps {
  return {
    async docker(args, opts) {
      calls.push({ args, cwd: opts.cwd, env: opts.env });
      const ok = (r: Reply = {}): DockerResult => ({ code: 0, stdout: "", stderr: "", ...r });
      if (dockerMissing) return ok({ code: 127, stderr: "docker: not found" });
      if (args[0] === "version") return ok();
      if (args[0] === "compose" && args[1] === "version") return ok({ stdout: composeVersion + "\n" });
      if (args.includes("ps") && args.includes("--status")) {
        return ok({ stdout: Array.from({ length: running }, (_, i) => `id${i}`).join("\n") });
      }
      if (args.includes("up")) return ok(upReply);
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
  };
}

function cmd(name: string) {
  const c = makeStackCommands(fakeDeps()).find((x) => x.name === name)!;
  return (args: Record<string, unknown> = {}, ctx: Record<string, unknown> = {}) =>
    c.run({ client: {} as never, readFile: () => "", ...ctx }, args) as Promise<Record<string, any>>;
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
    expect(COMPOSE_YML).toContain('AllowedHosts: "api;api.localhost;admin.localhost;localhost;127.0.0.1"');
    expect(COMPOSE_YML).toContain("http://admin.localhost:${PORT},http://client.localhost:${PORT}");
    expect(COMPOSE_YML).toContain("CMS_TENANT: client");
    expect(COMPOSE_YML).toContain("Tenancy__Mode: Single");
    expect(COMPOSE_YML).toContain('NEXT_PUBLIC_API_URL: "http://admin.localhost:${PORT}"');
    for (const k of ["PermitLimit", "WindowSeconds", "QueueLimit"]) {
      expect(COMPOSE_YML).toContain(`RateLimiting__Global__${k}:`);
    }
  });

  it("Caddy routes the hosts as designed", () => {
    expect(CADDYFILE).toMatch(/http:\/\/client\.localhost:8080 \{\s+handle \/files\* \{\s+reverse_proxy api:8080 \{\s+header_up X-Tenant client/);
    expect(CADDYFILE).toMatch(/http:\/\/admin\.localhost:8080 \{\s+handle \/api\/\* \{\s+reverse_proxy api:8080/);
    expect(CADDYFILE).toContain("reverse_proxy console:3000");
    expect(CADDYFILE).toContain("reverse_proxy site:3000");
    expect(CADDYFILE).toContain("http://api.localhost:8080");
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
      "compose", "-p", "barako", "-f", join(dir(), "compose.yml"), "--env-file", join(dir(), ".env"), "up", "-d", "--wait",
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
    expect(out.mcp).toContain("barako mcp");
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
