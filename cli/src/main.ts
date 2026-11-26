import { parseArgs } from "node:util";
import type { BarakoClient, ResourceDefinition } from "@baryodev/barako-client";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { connect, type Env } from "./connect";
import { CliError, render, scrubText, toCliError, type Outcome } from "./output";
import { commands, type ArgSpec, type Command, type Stdio } from "./registry";
import { loadResourcesFile } from "./resources-file";
import "./commands/destructive";
import "./commands/generic";
import "./commands/mcp";
import "./commands/read";
import "./commands/stack";
import "./commands/status";
import "./commands/write";

export interface Io {
  readFile(path: string): string;
  write(stream: "stdout" | "stderr", text: string): void;
  /** Standard input, for `mcp`. */
  stdin?: AsyncIterable<string | Uint8Array>;
  /** True when stdin is a terminal. `reset` asks only then. */
  isTTY?: boolean;
  /** Asks one question on the terminal and returns the answer. */
  ask?(question: string): Promise<string>;
  /** Calls back when stdout fails, such as a closed pipe (EPIPE). `mcp` stops serving then. */
  onStdoutError?(cb: () => void): void;
}

const SECRET_FLAGS = ["--api-key", "--apikey", "--key", "--token", "--secret"];

/** Options every command accepts. The parser and `barako commands` both read this. */
const GLOBAL_OPTIONS: (ArgSpec & { short?: string })[] = [
  { name: "url", kind: "flag", type: "string", description: "API base URL. Default is BARAKO_URL." },
  { name: "key-file", kind: "flag", type: "string", description: "File holding the API key. Default is BARAKO_API_KEY." },
  { name: "allow-http", kind: "flag", type: "boolean", description: "Allow the API key over plain http to a host that is not loopback. Default is BARAKO_ALLOW_HTTP=1." },
  { name: "output", short: "o", kind: "flag", type: "string", description: "json (default) or text." },
];

const commandsCommand: Command = {
  name: "commands",
  summary: "List every command with its arguments, and the global options.",
  args: [],
  offline: true,
  async run() {
    const list = [commandsCommand, ...commands].map((c) => ({
      name: c.name,
      summary: c.summary,
      args: c.args,
    }));
    return { commands: list, globals: GLOBAL_OPTIONS };
  },
};

function findCommand(argv: string[]): { command: Command; rest: string[] } | undefined {
  let best: { command: Command; rest: string[]; len: number } | undefined;
  for (const command of [commandsCommand, ...commands]) {
    const parts = command.name.split(" ");
    if (parts.every((p, i) => argv[i] === p) && (!best || parts.length > best.len)) {
      best = { command, rest: argv.slice(parts.length), len: parts.length };
    }
  }
  return best;
}

function parseCommandArgs(command: Command, rest: string[]): Record<string, unknown> {
  const options: Record<string, { type: "string" | "boolean"; multiple?: boolean; short?: string }> = {};
  for (const g of GLOBAL_OPTIONS) {
    options[g.name] = { type: g.type === "boolean" ? "boolean" : "string", ...(g.short ? { short: g.short } : {}) };
  }
  for (const a of command.args) {
    if (a.kind !== "flag") continue;
    options[a.name] = {
      type: a.type === "boolean" ? "boolean" : "string",
      ...(a.type === "string[]" ? { multiple: true } : {}),
    };
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options,
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    // Name the flag only. The message can carry argv values, which may be a key.
    const flag = /'(--?[^'=\s<]+)/.exec((err as Error).message)?.[1];
    const code = (err as { code?: string }).code;
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      throw new CliError("usage", `Unknown option ${flag ?? ""}`.trim() + ".");
    }
    throw new CliError("usage", flag ? `Invalid use of option ${flag}.` : "Invalid arguments.");
  }
  const out: Record<string, unknown> = {};
  const positionals = command.args.filter((a) => a.kind === "positional");
  if (parsed.positionals.length > positionals.length) {
    throw new CliError("usage", "Unexpected positional argument.");
  }
  positionals.forEach((spec, i) => {
    const v = parsed.positionals[i];
    if (v !== undefined) out[spec.name] = coerce(spec, v);
  });
  for (const spec of command.args) {
    if (spec.kind !== "flag") continue;
    const v = parsed.values[spec.name];
    if (v === undefined) continue;
    out[spec.name] = Array.isArray(v) ? v.map((x) => coerce(spec, x)) : coerce(spec, v);
  }
  for (const spec of command.args) {
    if (spec.required && out[spec.name] === undefined) {
      throw new CliError("usage", `Missing ${spec.kind} "${spec.name}".`);
    }
  }
  out.__url = parsed.values.url;
  out.__keyFile = parsed.values["key-file"];
  out.__allowHttp = parsed.values["allow-http"] === true;
  out.__output = parsed.values.output;
  return out;
}

function coerce(spec: ArgSpec, v: string | boolean): unknown {
  if (spec.type === "number") {
    const n = Number(v);
    if (typeof v !== "string" || v.trim() === "" || Number.isNaN(n)) {
      throw new CliError("usage", `"${spec.name}" must be a number.`);
    }
    return n;
  }
  return v;
}

function toText(outcome: Outcome): string {
  if (!outcome.ok) return `error (${outcome.error.code}): ${outcome.error.message}\n`;
  const r = outcome.result;
  return (typeof r === "string" ? r : JSON.stringify(r, null, 2)) + "\n";
}

/** Every key candidate to scrub: the env key plus the contents of any key file named
 *  before `--`. connect() adds the key it actually used. */
function candidateSecrets(argv: string[], env: Env, io: Io): string[] {
  const out: string[] = [];
  if (env.BARAKO_API_KEY?.trim()) out.push(env.BARAKO_API_KEY.trim());
  const end = argv.indexOf("--");
  const scan = end === -1 ? argv : argv.slice(0, end);
  const files: string[] = [];
  for (let i = 0; i < scan.length; i++) {
    const t = scan[i]!;
    if (t === "--key-file" && scan[i + 1] !== undefined) files.push(scan[i + 1]!);
    else if (t.startsWith("--key-file=")) files.push(t.slice("--key-file=".length));
  }
  for (const f of files) {
    try {
      const v = io.readFile(f).trim();
      if (v) out.push(v);
    } catch {
      // connect() reports an unreadable file.
    }
  }
  return out;
}

const noClient = new Proxy({}, {
  get() {
    throw new CliError("usage", "This command needs no connection.");
  },
}) as BarakoClient;

export async function run(argv: string[], env: Env, io: Io): Promise<number> {
  const secrets = candidateSecrets(argv, env, io);
  let outcome: Outcome;
  let format = "json";
  try {
    const flagged = argv.find((t) => SECRET_FLAGS.some((f) => t === f || t.startsWith(f + "=")));
    if (flagged) {
      throw new CliError(
        "usage",
        "Do not pass the API key on the command line. Set BARAKO_API_KEY or use --key-file.",
      );
    }
    const found = findCommand(argv);
    if (!found) {
      throw new CliError(
        "usage",
        `Unknown command${argv[0] ? ` "${argv[0]}"` : ""}. Run "commands" to list them.`,
      );
    }
    const args = parseCommandArgs(found.command, found.rest);
    const output = args.__output as string | undefined;
    if (output !== undefined && output !== "json" && output !== "text") {
      throw new CliError("usage", `Unknown output format "${output}". Use json or text.`);
    }
    format = output ?? "json";
    let fileResources: ResourceDefinition[] | undefined;
    if (found.command.usesResources) {
      const flagged = typeof args.resources === "string" ? args.resources : undefined;
      const path = flagged ?? (env.BARAKO_RESOURCES?.trim() || undefined);
      if (path !== undefined) fileResources = loadResourcesFile(path, io.readFile);
    }
    let client: BarakoClient = noClient;
    if (!found.command.offline) {
      const conn = connect(
        env,
        {
          url: args.__url as string | undefined,
          keyFile: args.__keyFile as string | undefined,
          allowHttp: args.__allowHttp === true,
        },
        io.readFile,
        fileResources,
      );
      secrets.push(conn.secret);
      client = conn.client;
    }
    const stdio: Stdio | undefined = io.stdin
      ? {
          input: io.stdin,
          write: (text) => io.write("stdout", text),
          log: (line) => io.write("stderr", line + "\n"),
          onWriteError: io.onStdoutError,
        }
      : undefined;
    const result = await found.command.run({ client, readFile: io.readFile, fileResources, stdio, secrets, isTty: io.isTTY === true, ask: io.ask }, args);
    if (found.command.silent) return 0;
    outcome = { ok: true, result };
  } catch (err) {
    outcome = { ok: false, error: toCliError(err) };
  }
  const rendered = render(outcome, secrets);
  if (format === "text") {
    const text = scrubText(toText(outcome), secrets);
    io.write(rendered.stream, text);
  } else {
    io.write(rendered.stream, rendered.text);
  }
  return rendered.exit;
}

// Run only when executed as the CLI, not when imported by tests.
const entry = process.argv[1] ?? "";
if (/(^|[\\/])(main\.js|barako)$/.test(entry)) {
  run(process.argv.slice(2), process.env as Env, {
    readFile: (p) => readFileSync(p, "utf8"),
    write: (stream, text) => {
      (stream === "stdout" ? process.stdout : process.stderr).write(text);
    },
    stdin: process.stdin,
    isTTY: process.stdin.isTTY === true,
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    // Without a listener an EPIPE is an unhandled error and the process dies with a stack trace.
    onStdoutError: (cb) => process.stdout.on("error", cb),
  }).then((code) => {
    process.exitCode = code;
  });
}
