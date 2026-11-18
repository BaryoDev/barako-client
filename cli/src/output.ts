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
    return new CliError(codeForStatus(err.status), err.message, {
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

/** The key as it may appear raw or URL-encoded. JSON escaping happens after the scrub. */
function forms(secret: string): string[] {
  const all = [secret, encodeURIComponent(secret)];
  return [...new Set(all)].filter((f) => f.length > 0);
}

export function scrubText(text: string, secret: string): string {
  return redact(text, secret);
}

function redact(text: string, secret: string): string {
  let out = text;
  for (const f of forms(secret)) out = out.split(f).join(REDACTED);
  return out;
}

function scrub(value: unknown, secret: string, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redact(value, secret);
  if (value === null || typeof value !== "object") return value;
  // `seen` holds the current ancestors only, so a shared reference is kept and a cycle is cut.
  if (seen.has(value)) return REDACTED;
  seen.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((v) => scrub(v, secret, seen));
  } else {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      o[redact(k, secret)] = scrub(v, secret, seen);
    }
    out = o;
  }
  seen.delete(value);
  return out;
}

export function render(outcome: Outcome, secret: string | undefined): Rendered {
  const body = outcome.ok
    ? { ok: true, result: outcome.result ?? null }
    : {
        ok: false,
        error: {
          code: outcome.error.code,
          status: outcome.error.status ?? null,
          message: outcome.error.message,
          details: outcome.error.details ?? null,
        },
      };
  const safe = secret ? scrub(body, secret, new WeakSet()) : body;
  const text = JSON.stringify(safe) ?? "null";
  return outcome.ok
    ? { stream: "stdout", text: text + "\n", exit: 0 }
    : { stream: "stderr", text: text + "\n", exit: exitFor(outcome.error.code) };
}
