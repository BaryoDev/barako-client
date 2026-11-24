import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
  /** One request to the stack's API. Status 0 means it could not be reached. */
  http(req: HttpRequest): Promise<HttpReply>;
  sleep(ms: number): Promise<void>;
  /** Milliseconds, for the readiness deadline. */
  now(): number;
}

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  json?: unknown;
  /** Cap for this request. Default 20 seconds. */
  timeoutMs?: number;
}

export interface HttpReply {
  status: number;
  body: string;
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
    async http(req) {
      try {
        const res = await fetch(req.url, {
          method: req.method,
          headers: { ...(req.json === undefined ? {} : { "content-type": "application/json" }), ...req.headers },
          body: req.json === undefined ? undefined : JSON.stringify(req.json),
          redirect: "manual",
          signal: AbortSignal.timeout(req.timeoutMs ?? 20_000),
        });
        return { status: res.status, body: await res.text() };
      } catch {
        return { status: 0, body: "" };
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
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
  /** Set once the tenant, kit and API key exist, so a second up does not sign in again. */
  bootstrap?: { kit: string; hash?: string };
}

/** The kit name rule core applies, anchored to the whole string. JavaScript's $ without the m flag never matches before a final newline. */
const KIT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_KIT = "blog";
/** The kit every stack gets first: Press needs the site settings. */
const BASE_KIT = "site";
/** The blueprints built into core 5.9.0. Core lists built-ins first, so a file with one of these names is never used. */
const BUILTIN_KITS = ["blog", "devsite", "docs", "email", "events", "portfolio", "site"];
const SERVICE_LIST = ["postgres", "api", "site", "console", "caddy"];
const MAX_KIT_BYTES = 256 * 1024;
const KEY_FILE = "api-key";
const ADMIN_URL = `http://127.0.0.1:${API_HOST_PORT}`;

export interface Kit {
  name: string;
  /** The file's text when the kit came from a path. It is copied into the stack folder, never run. */
  file?: string;
  /** sha256 of the file's text. */
  hash?: string;
}

const NOT_A_KIT = "--kit is not a kit name (lower-case letters, digits and hyphens) and not a file that exists. Start a relative path with ./";
const KIT_JSON = 'The kit file must be plain JSON (no comments, no trailing commas) with a "name" field of lower-case letters, digits and hyphens.';

/** A kit given with --kit: a name core knows, or a path to a blueprint file. A name wins when the text is a valid name. */
export function resolveKit(value: unknown): Kit | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new CliError("usage", "--kit needs a kit name or a path to a kit file.");
  if (KIT_NAME.test(value)) return { name: value };
  // One descriptor for the check and the read, so the file cannot change between them.
  let fd: number;
  try {
    fd = openSync(value, "r");
  } catch {
    throw new CliError("usage", NOT_A_KIT);
  }
  let text: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new CliError("usage", NOT_A_KIT);
    if (st.size > MAX_KIT_BYTES) throw new CliError("usage", "The kit file is larger than 256 KB.");
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  let name: unknown;
  try {
    name = (JSON.parse(text.replace(/^\uFEFF/, "")) as { name?: unknown }).name;
  } catch {
    throw new CliError("usage", KIT_JSON);
  }
  const norm = typeof name === "string" ? name.trim().toLowerCase() : "";
  if (!KIT_NAME.test(norm)) throw new CliError("usage", KIT_JSON);
  if (BUILTIN_KITS.includes(norm)) {
    throw new CliError("usage", `The kit file is named '${norm}', which is a built-in kit in core 5.9.0, so core would use the built-in and ignore the file. Rename the kit in the file.`);
  }
  return { name: norm, file: text, hash: createHash("sha256").update(text).digest("hex") };
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
    const b = (s as { bootstrap?: unknown }).bootstrap;
    const bootOk =
      b === undefined ||
      (typeof b === "object" && b !== null && typeof (b as { kit?: unknown }).kit === "string" && ((b as { hash?: unknown }).hash === undefined || typeof (b as { hash?: unknown }).hash === "string"));
    return ok && bootOk ? s : CORRUPT;
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

/** Writes a 0600 file that must not exist yet. A tmp file is linked into place so a crash never leaves half a file. */
export function createPrivateFile(dir: string, name: string, text: string): void {
  const tmp = join(dir, `${name}.tmp`);
  const clash = () => new CliError("conflict", `Another barako up wrote ${name === ".env" ? ".env" : "the key file"} first. Run barako up again.`);
  try {
    unlinkSync(tmp);
  } catch {
    // No leftover.
  }
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw clash();
    throw e;
  }
  try {
    linkSync(tmp, join(dir, name));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw clash();
    throw e;
  } finally {
    unlinkSync(tmp);
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
    createPrivateFile(dir, ".env", SECRET_NAMES.map((k) => `${k}=${values[k]}`).join("\n") + "\n");
  }
  // Core runs as another user in its container and must read the kit, which is not a secret. A umask of 077 would hide it.
  mkdirSync(join(dir, "blueprints"), { recursive: true, mode: 0o755 });
  chmodSync(join(dir, "blueprints"), 0o755);
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

/** The services compose reports as running. */
async function runningServices(deps: StackDeps, dir: string, state: State): Promise<string[]> {
  const r = await compose(deps, dir, state, ["ps", "--services", "--status", "running"]);
  if (r.code !== 0) throw failure("docker compose ps failed", r, dir);
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

function fail(step: string, r: HttpReply): CliError {
  if (r.status === 0) return new CliError("network", `${step}: the API at ${ADMIN_URL} did not answer.`);
  return new CliError("server", `${step} failed (HTTP ${r.status}).`);
}

function field(body: string, ...names: string[]): string | undefined {
  try {
    const o = JSON.parse(body) as Record<string, unknown>;
    for (const n of names) if (typeof o[n] === "string" && (o[n] as string).length > 0) return o[n] as string;
  } catch {
    // Not JSON.
  }
  return undefined;
}

/** Core's validation texts from a problem body, without control characters, at most 500 characters. Only for the kit route. */
function reasons(body: string): string {
  const out: string[] = [];
  try {
    const errors = (JSON.parse(body) as { errors?: unknown }).errors;
    const walk = (v: unknown): void => {
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(errors);
  } catch {
    // No reasons to show.
  }
  // eslint-disable-next-line no-control-regex
  return out.join(" ").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

/** Core's refusal for this kit when its types are already there: "Blueprint 'x' was not applied: a, b already exist in this tenant." */
function alreadyApplied(body: string, name: string): boolean {
  const texts: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") texts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  try {
    walk(JSON.parse(body));
  } catch {
    texts.push(body);
  }
  const head = `Blueprint '${name}' was not applied: `;
  return texts.some((t) => t.startsWith(head) && /already exists? in this tenant\./.test(t));
}

const READY_MS = 90_000;

async function waitReady(deps: StackDeps, log: (line: string) => void): Promise<void> {
  log("Waiting for the API.");
  const deadline = deps.now() + READY_MS;
  for (;;) {
    const left = deadline - deps.now();
    if (left <= 0) break;
    const r = await deps.http({ method: "GET", url: `${ADMIN_URL}/health/ready`, timeoutMs: Math.min(5000, left) });
    if (r.status === 200) return;
    await deps.sleep(1000);
  }
  throw new CliError("network", "The API did not become ready in 90 seconds. Check docker compose logs for the api service. Run barako up again.");
}

function api(deps: StackDeps, method: "GET" | "POST", path: string, opts: { token?: string; tenant?: string; json?: unknown } = {}) {
  return deps.http({
    method,
    url: ADMIN_URL + path,
    json: opts.json,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.tenant ? { "x-tenant": opts.tenant } : {}),
    },
  });
}

/** Asks the API whether the key in the file still opens anything. A network failure is an error, never a reason to start over. */
async function keyStillWorks(deps: StackDeps, dir: string): Promise<boolean> {
  const key = readFileSync(join(dir, KEY_FILE), "utf8").trim();
  const r = await api(deps, "GET", "/api/content-types", { token: key, tenant: TENANT });
  if (r.status === 401) return false;
  // A 403 means the key was recognised.
  if (r.status === 200 || r.status === 403) return true;
  throw fail("Checking the API key", r);
}

/**
 * Creates the tenant, applies the kits and, when there is no key file, makes the API key. With a marker
 * the tenant exists, so it signs in once, as the tenant. Errors name a step and a status, never a
 * response body (the kit route also gives core's validation texts), and the password and the key are
 * never printed.
 */
async function bootstrap(
  deps: StackDeps,
  dir: string,
  kit: Kit,
  opts: { first: boolean },
  log: (line: string) => void,
): Promise<{ keyCreated: boolean }> {
  const password = parseEnv(readFileSync(join(dir, ".env"), "utf8")).ADMIN_PASSWORD ?? "";
  const call = (method: "GET" | "POST", path: string, o: { token?: string; tenant?: string; json?: unknown } = {}) => api(deps, method, path, o);

  // Sign-in is limited to 5 attempts in 15 minutes, so there is no retry here.
  const signIn = async (tenant?: string): Promise<string> => {
    const r = await call("POST", "/api/auth/login", { tenant, json: { Username: ADMIN_USER, Password: password } });
    if (r.status === 429) throw new CliError("server", "Sign-in is rate limited (5 attempts in 15 minutes). Wait 15 minutes and run barako up again.");
    if (r.status === 401) {
      throw new CliError(
        "unauthorized",
        tenant
          ? `Signing in to the tenant ${tenant} was refused. Check that admin is an active member of it and that the tenant is active.`
          : `The admin password in .env was refused. ${BROKEN}`,
      );
    }
    if (r.status !== 200) throw fail("Sign-in", r);
    const token = field(r.body, "token", "Token");
    if (!token) throw new CliError("server", "Sign-in did not return a token.");
    return token;
  };

  await waitReady(deps, log);
  log("Signing in.");
  if (opts.first) {
    const first = await signIn();
    const tenant = await call("POST", "/api/tenants", { token: first, json: { Handle: TENANT, Name: "Client" } });
    if (tenant.status === 409) throw new CliError("conflict", `Creating the tenant '${TENANT}' clashed with a domain already in use.`);
    const existed = tenant.status === 400 && tenant.body.includes("A tenant with this handle already exists.");
    if (tenant.status !== 200 && tenant.status !== 201 && !existed) throw fail("Creating the tenant", tenant);
  }

  const token = await signIn(TENANT);
  // The site kit first, because Press needs it, then the chosen kit.
  for (const name of opts.first && kit.name !== BASE_KIT ? [BASE_KIT, kit.name] : [kit.name]) {
    const applied = await call("POST", `/api/content-types/blueprints/${encodeURIComponent(name)}`, { token, tenant: TENANT });
    if (applied.status === 200 || applied.status === 201) continue;
    // Applying is all or nothing. Only core's "already exist" refusal means it was applied before.
    if (applied.status === 409 && alreadyApplied(applied.body, name)) continue;
    if (applied.status === 404) {
      throw new CliError("not_found", `The stack does not know a kit called '${name}'. If you passed a file, run barako down and barako up again so the stack can read it.`);
    }
    const why = reasons(applied.body);
    throw new CliError(applied.status === 409 ? "conflict" : "server", `Applying the kit '${name}' failed (HTTP ${applied.status}).${why ? ` ${why}` : ""}`);
  }

  const keyPath = join(dir, KEY_FILE);
  if (existsSync(keyPath)) {
    chmodSync(keyPath, 0o600);
    return { keyCreated: false };
  }
  const expires = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  const made = await call("POST", "/api/api-keys", {
    token,
    tenant: TENANT,
    json: { Name: "barako up", Scopes: ["content:read", "content:write"], ExpiresAt: expires, ContentTypes: [], ReadOnly: false },
  });
  if (made.status !== 200 && made.status !== 201) throw fail("Creating the API key", made);
  const key = field(made.body, "key", "Key");
  if (!key) throw new CliError("server", "Creating the API key did not return a key.");
  createPrivateFile(dir, KEY_FILE, key + "\n");
  return { keyCreated: true };
}

/** The barako mcp command for this stack. The key stays in its file. */
function mcpLine(dir: string): string {
  const quote = (p: string) => (/[\s'"$`\\]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p);
  return `barako mcp --allow-writes --url ${ADMIN_URL} --key-file ${quote(join(dir, KEY_FILE))}`;
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
    ...(existsSync(join(dir, KEY_FILE)) ? { apiKeyFile: join(dir, KEY_FILE), mcp: mcpLine(dir) } : {}),
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
      { name: "kit", kind: "flag", type: "string", description: `A kit to apply: a name core knows (default ${DEFAULT_KIT}), or the path to a blueprint file. A file is copied into the stack folder and read by core, never run.` },
      { name: "latest", kind: "flag", type: "boolean", description: "Use the newest published core, Press and Brew images instead of the versions pinned in this release." },
    ],
    offline: true,
    async run(ctx: RunContext, args) {
      const dir = stackDir(deps);
      const wantPort = args.port === undefined ? undefined : parsePort(args.port);
      const wantLatest = args.latest === true;
      const kit = resolveKit(args.kit);

      await requireDocker(deps);

      const prior = loadState(dir);
      const envPath = join(dir, ".env");
      // After the stack is up: the tenant, the kit and the key. Skipped when an earlier up did them.
      const finish = async (state: State, base: Record<string, unknown>) => {
        const log = (l: string) => ctx.stdio?.log(l);
        const done = state.bootstrap;
        const keyPath = join(dir, KEY_FILE);
        const hadKey = existsSync(keyPath);
        const kitChanged = kit !== undefined && done !== undefined && (kit.name !== done.kit || (kit.hash !== undefined && kit.hash !== done.hash));
        const notices: string[] = [];
        let bootstrapped = false;
        let needed = done === undefined || !hadKey || kitChanged;
        if (!needed && !(await keyStillWorks(deps, dir))) {
          // The key file is there but core does not know it, so make a new one.
          unlinkSync(keyPath);
          needed = true;
        }
        if (needed) {
          const use: Kit = kit ?? { name: done?.kit ?? DEFAULT_KIT };
          if (use.file !== undefined) {
            const target = join(dir, "blueprints", `${use.name}.json`);
            writeIfChanged(target, use.file);
            // Core runs as another user in its container and must read the kit, which is not a secret.
            chmodSync(target, 0o644);
          }
          if (done === undefined && hadKey) {
            notices.push("An API key from an earlier barako up is in the stack folder. It is kept and not checked. If it fails, delete the api-key file and run barako up again. Keys made by barako up expire after 365 days.");
          }
          if (kitChanged && kit!.name === done!.kit) {
            notices.push("The kit file changed since the last up. Applying a kit only adds types, so types that already exist keep their old fields.");
          }
          const out = await bootstrap(deps, dir, use, { first: done === undefined }, log);
          bootstrapped = true;
          if (out.keyCreated && hadKey) notices.push("Made a new API key because the old one was refused.");
          state.bootstrap = { kit: use.name, ...(use.hash ? { hash: use.hash } : {}) };
          writeIfChanged(join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n", 0o600);
        }
        const merged = [typeof base.notice === "string" ? base.notice : undefined, ...notices].filter(Boolean).join(" ");
        return { ...base, bootstrapped, ...(merged ? { notice: merged } : {}), ...summary(dir, state) };
      };
      if (!existsSync(envPath)) {
        if (prior || (await volumeExists(deps))) {
          throw new CliError("conflict", `Stack data exists but .env is gone, so new passwords would not match the database. ${BROKEN}`);
        }
      } else if (!envComplete(dir)) {
        throw new CliError("conflict", `.env is missing a secret. ${BROKEN}`);
      }

      // The guarantee holds on every path, also when the stack is already running.
      if (existsSync(envPath)) chmodSync(envPath, 0o600);
      const upNow = prior ? await runningServices(deps, dir, prior) : [];
      const running = upNow.length;
      if (prior && running > 0) {
        const changed = (wantPort !== undefined && wantPort !== prior.port) || (wantLatest && !prior.latest);
        if (changed) {
          throw new CliError("conflict", "The stack is running with other settings. Run barako down, then barako up with the new ones.");
        }
        if (SERVICE_LIST.every((n) => upNow.includes(n))) {
          const stale = filesDiffer(dir);
          return finish(prior, {
            alreadyRunning: true,
            ...(stale ? { notice: "The stack files in this release differ from the running stack. Run barako down, then barako up, to apply them." } : {}),
          });
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
            ...(prior?.bootstrap ? { bootstrap: prior.bootstrap } : {}),
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
      const after = await runningServices(deps, dir, state);
      const missing = SERVICE_LIST.filter((n) => !after.includes(n));
      if (missing.length > 0) {
        throw new CliError("server", `docker compose up finished but these services are not running: ${missing.join(", ")}. Run docker compose logs for them in ${dir}, then barako up again.`);
      }
      const notice = state.latest ? "Using the newest published images, not the versions pinned in this release." : undefined;
      return finish(state, { alreadyRunning: false, ...(notice ? { notice } : {}) });
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
        forgetBootstrap(dir, state);
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
      for (const f of [statePath, envPath, join(dir, KEY_FILE)]) {
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

/** The data is gone, so the key in api-key no longer opens anything and the next up must bootstrap again. */
function forgetBootstrap(dir: string, state: State): void {
  try {
    unlinkSync(join(dir, KEY_FILE));
  } catch {
    // None.
  }
  delete state.bootstrap;
  writeIfChanged(join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n", 0o600);
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
