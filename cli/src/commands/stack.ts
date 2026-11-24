import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
// --wait and --wait-timeout both arrived in compose 2.17.0.
const MIN_COMPOSE = [2, 17, 0];
const VOLUME = "barako_pgdata";
const SECRET_NAMES = ["DB_PASSWORD", "APP_DB_PASSWORD", "JWT_KEY", "PRESS_SECRET", "ADMIN_PASSWORD"] as const;
const BROKEN = "Run barako reset to start over.";

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

/**
 * The environment for a docker call. Compose gives the process environment precedence over the
 * .env file, so a secret name exported in the shell is dropped here and the file's value is used.
 */
export function dockerEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const k of [...SECRET_NAMES, ...Object.keys(extra)]) delete out[k];
  return { ...out, ...extra };
}

export function realDeps(): StackDeps {
  return {
    docker(args, opts) {
      return new Promise((resolve) => {
        const child = spawn("docker", args, {
          cwd: opts.cwd,
          env: dockerEnv(process.env, opts.env ?? {}),
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


/** A port as an integer from 1024 to 65535. */
export function parsePort(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new CliError("usage", "--port must be a whole number from 1024 to 65535.");
  }
  if (n === API_HOST_PORT) {
    throw new CliError("usage", `--port ${API_HOST_PORT} is where barako up publishes the API. Pick another port.`);
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

const CORRUPT = Symbol("corrupt");

/** The state, undefined when there is none, CORRUPT when state.json cannot be read as a state. */
function readState(dir: string): State | undefined | typeof CORRUPT {
  let text: string;
  try {
    text = readFileSync(join(dir, "state.json"), "utf8");
  } catch {
    return undefined;
  }
  try {
    const s = JSON.parse(text) as State;
    const ok =
      Number.isInteger(s.port) &&
      typeof s.latest === "boolean" &&
      ["core", "press", "brew", "postgres", "caddy"].every((k) => {
        const p = (s.versions as unknown as Record<string, Pin | undefined> | undefined)?.[k];
        return !!p && typeof p.image === "string" && typeof p.tag === "string";
      });
    return ok ? s : CORRUPT;
  } catch {
    return CORRUPT;
  }
}

function loadState(dir: string): State | undefined {
  const s = readState(dir);
  if (s === CORRUPT) throw new CliError("conflict", `state.json is unreadable. ${BROKEN}`);
  return s;
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let v = m[2]!;
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0]!)) v = v.slice(1, -1);
    out[m[1]!] = v;
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

/** True when .env holds every secret, non-empty. */
function envComplete(dir: string): boolean {
  try {
    const env = parseEnv(readFileSync(join(dir, ".env"), "utf8"));
    return SECRET_NAMES.every((k) => (env[k] ?? "").length > 0);
  } catch {
    return false;
  }
}

/** The directory is 0700 and .env is 0600. .env is created only when absent, by a link so a crash never leaves half a file. */
export function writeStack(deps: StackDeps, dir: string, state: State): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const envPath = join(dir, ".env");
  if (existsSync(envPath)) {
    chmodSync(envPath, 0o600);
  } else {
    const values: Record<(typeof SECRET_NAMES)[number], string> = {
      DB_PASSWORD: deps.token(24),
      APP_DB_PASSWORD: deps.token(24),
      JWT_KEY: deps.token(48),
      PRESS_SECRET: deps.token(32),
      // The prefix makes sure the password has upper, lower, a digit and a symbol.
      ADMIN_PASSWORD: "Aa1-" + deps.token(18),
    };
    const text = SECRET_NAMES.map((k) => `${k}=${values[k]}`).join("\n") + "\n";
    const tmp = join(dir, ".env.tmp");
    try {
      unlinkSync(tmp);
    } catch {
      // No leftover.
    }
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    try {
      linkSync(tmp, envPath);
    } finally {
      unlinkSync(tmp);
    }
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
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.stdout.trim());
  if (!m) throw new CliError("usage", "Could not read the docker compose version. barako up needs 2.17.0 or newer.");
  const have = [Number(m[1]), Number(m[2]), Number(m[3])];
  const cmp = MIN_COMPOSE.reduce<number>((c, min, i) => (c !== 0 ? c : Math.sign(have[i]! - min)), 0);
  if (cmp < 0) {
    throw new CliError(
      "usage",
      `Docker Compose ${have.join(".")} is too old. barako up needs ${MIN_COMPOSE.join(".")} or newer for --wait.`,
    );
  }
}

async function runningCount(deps: StackDeps, dir: string, state: State): Promise<number> {
  const r = await compose(deps, dir, state, ["ps", "--status", "running", "-q"]);
  if (r.code !== 0) throw failure("docker compose ps failed", r, dir);
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
    versions: Object.fromEntries(Object.entries(state.versions).map(([k, p]) => [k, imageRef(p)])),
  };
}

/** True when the embedded files differ from what is on disk. */
function filesDiffer(dir: string): boolean {
  const want: Record<string, string> = {
    "compose.yml": COMPOSE_YML,
    Caddyfile: CADDYFILE,
    "app-role.sql": APP_ROLE_SQL,
    "versions.json": VERSIONS_JSON,
  };
  return Object.entries(want).some(([f, c]) => {
    try {
      return readFileSync(join(dir, f), "utf8") !== c;
    } catch {
      return true;
    }
  });
}

async function volumeExists(deps: StackDeps): Promise<boolean> {
  return (await deps.docker(["volume", "inspect", VOLUME], {})).code === 0;
}

export function makeStackCommands(deps: StackDeps): Command[] {
  const up: Command = {
    name: "up",
    summary: "Start a local stack (Postgres, core, Press, Brew, Caddy) from pinned images. Files and secrets live in ~/.barako/stack.",
    args: [
      // A string, so the raw text reaches parsePort. A number would turn 0x1F90 or 1e4 into a valid port.
      { name: "port", kind: "flag", type: "string", description: `Port for the site and console on 127.0.0.1, 1024 to 65535. Default ${DEFAULT_PORT}.` },
      { name: "latest", kind: "flag", type: "boolean", description: "Use the newest published core, Press and Brew images instead of the versions pinned in this release." },
    ],
    offline: true,
    async run(ctx: RunContext, args) {
      const dir = stackDir(deps);
      const wantPort = args.port === undefined ? undefined : parsePort(args.port);
      const wantLatest = args.latest === true;

      await requireDocker(deps);

      const prior = loadState(dir);
      const envPath = join(dir, ".env");
      if (!existsSync(envPath)) {
        if (prior || (await volumeExists(deps))) {
          throw new CliError("conflict", `Stack data exists but .env is gone, so new passwords would not match the database. ${BROKEN}`);
        }
      } else if (!envComplete(dir)) {
        throw new CliError("conflict", `.env is missing a secret. ${BROKEN}`);
      }

      const running = prior ? await runningCount(deps, dir, prior) : 0;
      if (prior && running > 0) {
        const changed = (wantPort !== undefined && wantPort !== prior.port) || (wantLatest && !prior.latest);
        if (changed) {
          throw new CliError("conflict", "The stack is running with other settings. Run barako down, then barako up with the new ones.");
        }
        if (running >= SERVICES) {
          const stale = filesDiffer(dir);
          return {
            alreadyRunning: true,
            ...(stale ? { notice: "The stack files in this release differ from the running stack. Run barako down, then barako up, to apply them." } : {}),
            ...summary(dir, prior),
          };
        }
      }

      // A stack that is partly up keeps its settings. A stopped one takes the flags, or the pinned versions.
      const keep = prior !== undefined && running > 0;
      const state: State = keep
        ? prior
        : {
            port: wantPort ?? prior?.port ?? DEFAULT_PORT,
            tenant: TENANT,
            latest: wantLatest,
            versions: wantLatest ? newest() : pinned(),
          };

      if (running === 0) {
        for (const port of [state.port, API_HOST_PORT]) {
          if (!(await deps.portFree(port))) {
            throw new CliError("conflict", `Port ${port} on 127.0.0.1 is in use. ${port === state.port ? "Pass --port with a free port." : "barako up publishes the API there."}`);
          }
        }
      }

      writeStack(deps, dir, state);
      ctx.stdio?.log("Starting the stack. The first run pulls images and can take several minutes.");
      const r = await compose(deps, dir, state, [
        "up", "-d", "--wait", "--wait-timeout", "600",
        ...(state.latest ? ["--pull", "always"] : []),
      ]);
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
      const state = loadState(dir);
      if (!state) return { configured: false, running: false };
      if (!existsSync(join(dir, ".env"))) throw new CliError("conflict", `.env is gone. ${BROKEN}`);
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
      const state = loadState(dir);
      if (!state) return { stopped: false, reason: "no stack set up" };
      if (!existsSync(join(dir, ".env"))) throw new CliError("conflict", `.env is gone. ${BROKEN}`);
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
      if (args.yes !== true && (!ctx.isTty || !ctx.ask)) {
        throw new CliError("usage", "reset deletes all local stack data. Stdin is not a terminal, so pass --yes to confirm.");
      }
      const dir = stackDir(deps);
      const statePath = join(dir, "state.json");
      const envPath = join(dir, ".env");
      const exists = existsSync(statePath) || existsSync(envPath) || (await volumeExists(deps));
      if (!exists) return { reset: false, reason: "no stack set up" };
      if (args.yes !== true) {
        const answer = (await ctx.ask!("Delete all local stack data? Type yes to go on: ")).trim().toLowerCase();
        if (answer !== "yes") return { reset: false, reason: "not confirmed" };
      }

      const state = readState(dir);
      if (state && state !== CORRUPT && envComplete(dir)) {
        const r = await compose(deps, dir, state, ["down", "--volumes", "--remove-orphans"]);
        if (r.code !== 0) throw failure("docker compose down failed", r, dir);
        return { reset: true, dataDeleted: true };
      }

      // The files compose needs are gone or unreadable. Remove by project label and name instead.
      const ps = await deps.docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${PROJECT}`], {});
      const ids = ps.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      if (ids.length > 0) await deps.docker(["rm", "-f", ...ids], {});
      if (await volumeExists(deps)) {
        const v = await deps.docker(["volume", "rm", VOLUME], {});
        if (v.code !== 0) throw failure("docker volume rm failed", v, dir);
      }
      await deps.docker(["network", "rm", `${PROJECT}_edge`], {});
      // Drop the broken files so the next up starts clean.
      for (const f of [statePath, envPath]) {
        try {
          unlinkSync(f);
        } catch {
          // Already gone.
        }
      }
      return { reset: true, dataDeleted: true, repaired: true };
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
