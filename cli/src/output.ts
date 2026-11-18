import { BarakoError } from "@baryodev/barako-client";

export type ErrorCode =
  | "usage"
  | "validation"
  | "rule"
  | "conflict"
  | "version_required"
  | "not_found"
  | "unauthorized"
  | "forbidden"
  | "server"
  | "network";

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, opts?: { status?: number; details?: unknown }) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.status = opts?.status;
    this.details = opts?.details;
  }
}

export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return "validation";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
    case 412:
      return "conflict";
    case 422:
      return "rule";
    case 428:
      return "version_required";
    case 429:
      return "server";
    default:
      return status >= 500 ? "server" : "validation";
  }
}

export function exitFor(code: ErrorCode): number {
  switch (code) {
    case "usage":
      return 1;
    case "validation":
    case "rule":
      return 2;
    case "conflict":
    case "version_required":
      return 3;
    case "not_found":
      return 4;
    case "unauthorized":
    case "forbidden":
      return 5;
    case "server":
    case "network":
      return 6;
  }
}

export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof BarakoError) {
    const message = err.status === 429 ? "The server is rate limiting this key. Retry later." : err.message;
    return new CliError(codeForStatus(err.status), message, {
      status: err.status,
      details: err.body,
    });
  }
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return new CliError("network", err.message);
    }
    if (err instanceof TypeError) {
      if (err.message.startsWith("Invalid path segment")) {
        return new CliError("usage", err.message);
      }
      if (err.message === "fetch failed" || (err as { cause?: unknown }).cause !== undefined) {
        return new CliError("network", err.message);
      }
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return new CliError("server", message);
}

export type Outcome = { ok: true; result: unknown } | { ok: false; error: CliError };

export interface Rendered {
  stream: "stdout" | "stderr";
  text: string;
  exit: number;
}

const REDACTED = "[redacted]";

/** The key as it may appear raw, JSON-escaped or URL-encoded. */
function forms(secret: string): string[] {
  const all = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)];
  return [...new Set(all)].filter((f) => f.length > 0);
}

type Secrets = string | readonly (string | undefined)[] | undefined;

function list(secrets: Secrets): string[] {
  const arr = typeof secrets === "string" ? [secrets] : (secrets ?? []);
  // Longest first, so a secret that contains another is fully removed.
  return arr.filter((x): x is string => !!x).sort((x, y) => y.length - x.length);
}

export function scrubText(text: string, secrets: Secrets): string {
  return redact(text, list(secrets));
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) for (const f of forms(secret)) out = out.split(f).join(REDACTED);
  return out;
}

function scrub(value: unknown, secrets: string[], seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (value === null || typeof value !== "object") return value;
  // `seen` holds the current ancestors only, so a shared reference is kept and a cycle is cut.
  if (seen.has(value)) return REDACTED;
  seen.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((v) => scrub(v, secrets, seen));
  } else {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      o[redact(k, secrets)] = scrub(v, secrets, seen);
    }
    out = o;
  }
  seen.delete(value);
  return out;
}

const WITHHELD =
  JSON.stringify({
    ok: false,
    error: { code: "server", status: 0, message: "output withheld: it contained the API key" },
  }) + "\n";

export function render(outcome: Outcome, secrets: Secrets): Rendered {
  const all = list(secrets);
  const clean = (v: unknown) => (all.length ? scrub(v, all, new WeakSet()) : v);
  // Envelope keys, code and status are fixed and never scrubbed.
  const payload = outcome.ok
    ? [clean(outcome.result ?? null)]
    : [clean(outcome.error.message), clean(outcome.error.details ?? null)];
  // Fail closed: serialize the scrubbed payload and make sure no form of a key survived
  // (for example one produced by a toJSON method after the scrub).
  const serialized = payload.map((p) => JSON.stringify(p) ?? "null");
  const joined = serialized.join("\n");
  for (const secret of all) {
    if (forms(secret).some((f) => joined.includes(f))) {
      return { stream: "stderr", text: WITHHELD, exit: exitFor("server") };
    }
  }
  const text = outcome.ok
    ? `{"ok":true,"result":${serialized[0]}}`
    : JSON.stringify({
        ok: false,
        error: {
          code: outcome.error.code,
          status: outcome.error.status ?? null,
          message: payload[0],
          details: payload[1],
        },
      });
  return outcome.ok
    ? { stream: "stdout", text: text + "\n", exit: 0 }
    : { stream: "stderr", text: text + "\n", exit: exitFor(outcome.error.code) };
}
