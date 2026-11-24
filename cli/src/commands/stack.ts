import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, scrubText } from "../output";
import { commands, type Command, type RunContext } from "../registry";
import {
  ADMIN_USER,
  API_HOST_PORT,
  APP_ROLE_SQL,
  CADDYFILE,
  COMPOSE_YML,
  TENANT,
  VERSIONS_JSON,
} from "../stack/files";

export const DEFAULT_PORT = 8080;
const PROJECT = "barako";
const SERVICES = 5;
const MIN_COMPOSE = [2, 17, 0];

export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything the commands touch outside the process. Tests pass fakes. */
export interface StackDeps {
  /** Runs `docker` with an argument array. Never a shell string. */
  docker(args: string[], opts: { cwd?: string; env?: Record<string, string> }): Promise<DockerResult>;
  /** True when nothing listens on 127.0.0.1:port. */
  portFree(port: number): Promise<boolean>;
  /** Random bytes, as base64url. */
  token(bytes: number): string;
  /** The user's home directory. The stack lives in <home>/.barako/stack. */
  home(): string;
}

export function realDeps(): StackDeps {
  return {
    docker(args, opts) {
      return new Promise((resolve) => {
        const child = spawn("docker", args, {
          cwd: opts.cwd,
          env: { ...process.env, ...opts.env },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (e) => resolve({ code: 127, stdout, stderr: stderr + (e as Error).message }));
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      });
    },
    portFree(port) {
      return new Promise((resolve) => {
        const s = createServer();
        s.once("error", () => resolve(false));
        s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
      });
    },
    token: (bytes) => randomBytes(bytes).toString("base64url"),
    home: () => homedir(),
  };
}

interface Pin {
  image: string;
  tag: string;
  digest?: string;
}
type Versions = Record<"core" | "press" | "brew" | "postgres" | "caddy", Pin>;

interface State {
  port: number;
  tenant: string;
  latest: boolean;
  versions: Versions;
}

const SECRET_NAMES = ["DB_PASSWORD", "APP_DB_PASSWORD", "JWT_KEY", "PRESS_SECRET", "ADMIN_PASSWORD"] as const;

/** A port as an integer from 1024 to 65535. */
export function parsePort(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new CliError("usage", "--port must be a whole number from 1024 to 65535.");
  }
  return n;
}

export function stackDir(deps: StackDeps): string {
  return join(deps.home(), ".barako", "stack");
}

function imageRef(p: Pin): string {
  return `${p.image}:${p.tag}${p.digest ? `@${p.digest}` : ""}`;
}

function pinned(): Versions {
  return JSON.parse(VERSIONS_JSON) as Versions;
}

/** The newest published tags: `latest` for core, Press and Brew, no digest. */
function newest(): Versions {
  const v = pinned();
  for (const k of ["core", "press", "brew"] as const) v[k] = { image: v[k].image, tag: "latest" };
  return v;
}

function readState(dir: string): State | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as State;
  } catch {
    return undefined;
  }
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function readSecrets(dir: string): string[] {
  try {
    return Object.values(parseEnv(readFileSync(join(dir, ".env"), "utf8"))).filter((v) => v.length > 0);
  } catch {
    return [];
  }
}

/** Writes a file only when its content differs. Returns true when it wrote. */
function writeIfChanged(path: string, content: string, mode = 0o644): boolean {
  try {
    if (readFileSync(path, "utf8") === content) return false;
  } catch {
    // Missing, so write it.
  }
  writeFileSync(path, content, { mode });
  return true;
}

/** The directory is 0700 and .env is 0600, created only when absent. */
function writeStack(deps: StackDeps, dir: string, state: State): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const envPath = join(dir, ".env");
  if (!existsSync(envPath)) {
    const values: Record<(typeof SECRET_NAMES)[number], string> = {
      DB_PASSWORD: deps.token(24),
      APP_DB_PASSWORD: deps.token(24),
      JWT_KEY: deps.token(48),
      PRESS_SECRET: deps.token(32),
      // The prefix makes sure the password has upper, lower, a digit and a symbol.
      ADMIN_PASSWORD: "Aa1-" + deps.token(18),
    };
    const text = SECRET_NAMES.map((k) => `${k}=${values[k]}`).join("\n") + "\n";
    writeFileSync(envPath, text, { mode: 0o600, flag: "wx" });
  }
  writeIfChanged(join(dir, "compose.yml"), COMPOSE_YML);
  writeIfChanged(join(dir, "Caddyfile"), CADDYFILE);
  writeIfChanged(join(dir, "app-role.sql"), APP_ROLE_SQL);
  writeIfChanged(join(dir, "versions.json"), VERSIONS_JSON);
  writeIfChanged(join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n", 0o600);
}

function composeEnv(state: State): Record<string, string> {
  return {
    PORT: String(state.port),
    CORE_IMAGE: imageRef(state.versions.core),
    PRESS_IMAGE: imageRef(state.versions.press),
    BREW_IMAGE: imageRef(state.versions.brew),
    POSTGRES_IMAGE: imageRef(state.versions.postgres),
    CADDY_IMAGE: imageRef(state.versions.caddy),
  };
}

async function compose(
  deps: StackDeps,
  dir: string,
  state: State,
  args: string[],
): Promise<DockerResult> {
  const full = ["compose", "-p", PROJECT, "-f", join(dir, "compose.yml"), "--env-file", join(dir, ".env"), ...args];
  return deps.docker(full, { cwd: dir, env: composeEnv(state) });
}

/** A compose failure as a message: the last lines of stderr with every .env value removed. Never the environment. */
function failure(what: string, r: DockerResult, dir: string): CliError {
  const tail = r.stderr.trim().split("\n").slice(-15).join("\n");
  return new CliError("server", `${what} (docker exit ${r.code}).\n${scrubText(tail, readSecrets(dir))}`.trim());
}

async function requireDocker(deps: StackDeps): Promise<void> {
  const v = await deps.docker(["compose", "version", "--short"], {});
  if (v.code !== 0) {
    const d = await deps.docker(["version", "--format", "{{.Client.Version}}"], {});
    throw new CliError(
      "usage",
      d.code !== 0
        ? "Docker is not installed or not running. Install Docker, start it, and run barako up again."
        : "Docker Compose v2 is missing. barako up needs the docker compose plugin.",
    );
  }
  const parts = v.stdout.trim().replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10));
  const old = MIN_COMPOSE.reduce<number>((cmp, min, i) => (cmp !== 0 ? cmp : Math.sign((parts[i] ?? 0) - min)), 0) < 0;
  if (parts.some(Number.isNaN) || old) {
    throw new CliError(
      "usage",
      `Docker Compose ${v.stdout.trim()} is too old. barako up needs ${MIN_COMPOSE.join(".")} or newer for --wait.`,
    );
  }
}

async function runningCount(deps: StackDeps, dir: string, state: State): Promise<number> {
  const r = await compose(deps, dir, state, ["ps", "--status", "running", "-q"]);
  if (r.code !== 0) return 0;
  return r.stdout.split("\n").filter((l) => l.trim()).length;
}

function urls(port: number) {
  return {
    site: `http://client.localhost:${port}`,
    console: `http://admin.localhost:${port}`,
    api: `http://api.localhost:${port}`,
    apiLocal: `http://127.0.0.1:${API_HOST_PORT}`,
  };
}

function summary(dir: string, state: State) {
  const u = urls(state.port);
  return {
    urls: u,
    adminUser: ADMIN_USER,
    passwordFile: join(dir, ".env"),
    passwordKey: "ADMIN_PASSWORD",
    mcp: `BARAKO_URL=${u.apiLocal} barako mcp --key-file ${join(dir, "api-key")}`,
    versions: Object.fromEntries(Object.entries(state.versions).map(([k, p]) => [k, imageRef(p)])),
  };
}

export function makeStackCommands(deps: StackDeps): Command[] {
  const up: Command = {
    name: "up",
    summary: "Start a local stack (Postgres, core, Press, Brew, Caddy) from pinned images. Files and secrets live in ~/.barako/stack.",
    args: [
      { name: "port", kind: "flag", type: "number", description: `Port for the site and console on 127.0.0.1. Default ${DEFAULT_PORT}.` },
      { name: "latest", kind: "flag", type: "boolean", description: "Use the newest published core, Press and Brew images instead of the versions pinned in this release." },
    ],
    offline: true,
    async run(_ctx: RunContext, args) {
      const dir = stackDir(deps);
      const wantPort = args.port === undefined ? undefined : parsePort(args.port);
      const wantLatest = args.latest === true;
      const prior = readState(dir);

      await requireDocker(deps);

      const state: State = {
        port: wantPort ?? prior?.port ?? DEFAULT_PORT,
        tenant: TENANT,
        latest: wantLatest,
        versions: wantLatest ? newest() : pinned(),
      };

      if (prior) {
        const running = await runningCount(deps, dir, prior);
        if (running > 0) {
          const changed = state.port !== prior.port || (wantLatest && !prior.latest);
          if (changed) {
            throw new CliError("conflict", "The stack is running with other settings. Run barako down, then barako up with the new ones.");
          }
          if (running >= SERVICES) return { alreadyRunning: true, ...summary(dir, prior) };
        }
      }

      for (const port of [state.port, API_HOST_PORT]) {
        if (!(await deps.portFree(port))) {
          const partial = prior ? await runningCount(deps, dir, prior) : 0;
          if (partial === 0) throw new CliError("conflict", `Port ${port} on 127.0.0.1 is in use. ${port === state.port ? "Pass --port with a free port." : "barako up publishes the API there."}`);
        }
      }

      writeStack(deps, dir, state);
      const r = await compose(deps, dir, state, ["up", "-d", "--wait"]);
      if (r.code !== 0) throw failure("docker compose up failed", r, dir);
      const notice = state.latest ? "Using the newest published images, not the versions pinned in this release." : undefined;
      return { alreadyRunning: false, ...(notice ? { notice } : {}), ...summary(dir, state) };
    },
  };

  const status: Command = {
    name: "status",
    summary: "Show whether the local stack is set up and which services run.",
    args: [],
    offline: true,
    async run() {
      const dir = stackDir(deps);
      const state = readState(dir);
      if (!state) return { configured: false, running: false };
      const r = await compose(deps, dir, state, ["ps", "--all", "--format", "json"]);
      if (r.code !== 0) throw failure("docker compose ps failed", r, dir);
      const rows = parsePs(r.stdout);
      return {
        configured: true,
        running: rows.length > 0 && rows.every((s) => s.state === "running"),
        port: state.port,
        services: rows,
        ...urls(state.port),
      };
    },
  };

  const down: Command = {
    name: "down",
    summary: "Stop the local stack and remove its containers. Data is kept.",
    args: [],
    offline: true,
    async run() {
      const dir = stackDir(deps);
      const state = readState(dir);
      if (!state) return { stopped: false, reason: "no stack set up" };
      const r = await compose(deps, dir, state, ["down", "--remove-orphans"]);
      if (r.code !== 0) throw failure("docker compose down failed", r, dir);
      return { stopped: true, dataKept: true };
    },
  };

  const reset: Command = {
    name: "reset",
    summary: "Stop the local stack and delete its data volumes. Asks first unless --yes.",
    args: [{ name: "yes", kind: "flag", type: "boolean", description: "Delete without asking. Needed when stdin is not a terminal." }],
    offline: true,
    async run(ctx, args) {
      if (args.yes !== true) {
        if (!ctx.isTty || !ctx.ask) {
          throw new CliError("usage", "reset deletes all local stack data. Stdin is not a terminal, so pass --yes to confirm.");
        }
        const answer = (await ctx.ask("Delete all local stack data? Type yes to go on: ")).trim().toLowerCase();
        if (answer !== "yes") return { reset: false, reason: "not confirmed" };
      }
      const dir = stackDir(deps);
      const state = readState(dir);
      if (!state) return { reset: false, reason: "no stack set up" };
      const r = await compose(deps, dir, state, ["down", "--volumes", "--remove-orphans"]);
      if (r.code !== 0) throw failure("docker compose down failed", r, dir);
      return { reset: true, dataDeleted: true };
    },
  };

  return [up, status, down, reset];
}

function parsePs(out: string): { service: string; state: string; health?: string }[] {
  const text = out.trim();
  if (!text) return [];
  let rows: unknown[];
  try {
    const parsed: unknown = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    rows = text.split("\n").flatMap((l) => {
      try {
        return [JSON.parse(l) as unknown];
      } catch {
        return [];
      }
    });
  }
  return rows.map((r) => {
    const o = r as { Service?: string; State?: string; Health?: string };
    return { service: o.Service ?? "?", state: o.State ?? "?", ...(o.Health ? { health: o.Health } : {}) };
  });
}

for (const c of makeStackCommands(realDeps())) commands.push(c);
