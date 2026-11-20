import { BarakoError } from "./errors";

/** Per-call options on the methods that accept them. */
export interface CallOptions {
  /** Abort this call. The error has code `aborted`. */
  signal?: AbortSignal;
  /** Timeout for this call in milliseconds, covering headers and body. 0 turns it off. Overrides the
   *  client's read or write default for this call. */
  timeoutMs?: number;
}

/** Timeouts by kind of request, in milliseconds. 0 means no limit. Reads are GET and HEAD, every
 *  other method is a write. */
export interface Timeouts {
  /** Default 30000. */
  readMs?: number;
  /** Default 0, no limit: a write that is cut off may still have been applied. */
  writeMs?: number;
}

/** What every request on a client shares: the config signal, the timeouts, and the contract
 *  check. */
export interface HttpLimits {
  signal?: AbortSignal;
  timeouts: { readMs: number; writeMs: number };
  onResponse?: (path: string, headers: Headers) => void;
}

export const DEFAULT_READ_TIMEOUT_MS = 30_000;
export const DEFAULT_WRITE_TIMEOUT_MS = 0;

export function isRead(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD";
}

/** Checks the `timeouts` config and fills the defaults. Throws naming the bad field. */
export function resolveTimeouts(timeouts?: Timeouts): { readMs: number; writeMs: number } {
  const out = {
    readMs: timeouts?.readMs ?? DEFAULT_READ_TIMEOUT_MS,
    writeMs: timeouts?.writeMs ?? DEFAULT_WRITE_TIMEOUT_MS,
  };
  for (const field of ["readMs", "writeMs"] as const) {
    const v = out[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(`createClient: timeouts.${field} must be 0 or a positive finite number of milliseconds.`);
    }
  }
  return out;
}

// setTimeout treats anything above this as 1 ms.
const MAX_TIMER_MS = 2_147_483_647;

/** A response whose body was read under the same timeout as the headers. */
export interface TextResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
  text: string;
}

/** The effective timeout: the per-call value if it is a usable number, else the default. */
export function resolveTimeout(perCall: number | undefined, fallback: number): number {
  if (typeof perCall === "number" && Number.isFinite(perCall) && perCall >= 0) return perCall;
  return fallback;
}

/**
 * One fetch plus its body read, bounded by a timeout and any number of signals. Node 18 has no
 * `AbortSignal.any`, so the signals are combined here with one controller, and every listener and
 * timer is removed when the call settles, so a long-lived signal does not collect listeners.
 *
 * A fetch that ignores its signal still loses the race, so a stalled fetch or body cannot hang.
 * Rejects only with BarakoError (codes `timeout`, `aborted`, `network`).
 */
export async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  limits: { signals: Array<AbortSignal | undefined>; timeoutMs: number },
): Promise<TextResponse> {
  const writes = !isRead(init.method);
  const unknownNote = writes ? " The outcome is unknown, the server may have applied the request." : "";
  const failure = (status: number, message: string, code: "timeout" | "aborted" | "network") =>
    new BarakoError(status, message, undefined, {
      code,
      outcomeUnknown: writes && code !== "aborted",
    });

  const controller = new AbortController();
  let fail!: (e: BarakoError) => void;
  const stop = new Promise<never>((_, reject) => {
    fail = reject;
  });
  stop.catch(() => {});
  const stopWith = (e: BarakoError) => {
    fail(e); // reject first, so the fetch's own AbortError loses the race
    controller.abort();
  };

  const onAbort = () => stopWith(failure(0, "The request was aborted.", "aborted"));
  const attached: AbortSignal[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    for (const signal of limits.signals) {
      if (!signal) continue;
      if (signal.aborted) throw failure(0, "The request was aborted.", "aborted");
      signal.addEventListener("abort", onAbort, { once: true });
      attached.push(signal);
    }
    if (limits.timeoutMs > 0) {
      timer = setTimeout(
        () =>
          stopWith(
            failure(0, `The request timed out after ${limits.timeoutMs} ms.${unknownNote}`, "timeout"),
          ),
        Math.min(limits.timeoutMs, MAX_TIMER_MS),
      );
    }

    const work = (async (): Promise<TextResponse> => {
      const res = await fetchImpl(url, { ...init, signal: controller.signal });
      const text = await res.text();
      return { status: res.status, statusText: res.statusText, ok: res.ok, headers: res.headers, text };
    })();
    work.catch(() => {}); // when stop wins, the late rejection is ignored
    return await Promise.race([work, stop]);
  } catch (e) {
    if (e instanceof BarakoError) throw e;
    const reason = e instanceof Error ? e.message : String(e);
    throw failure(0, `Network error: ${reason}.${unknownNote}`, "network");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    for (const signal of attached) signal.removeEventListener("abort", onAbort);
  }
}

const MAX_TEXT = 500;

/** Cuts text that came from a server we do not control, so a proxy page cannot flood an error
 *  message or a log. The result is at most MAX_TEXT characters. */
export function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 3)}...` : text;
}

/** The error for a response whose body should have been JSON and was not. */
export function invalidJson(status: number, text: string): BarakoError {
  return new BarakoError(status, "The API answered with a body that is not JSON.", clip(text), {
    code: "invalid-json",
  });
}

/** The error for a non-2xx response. A JSON body stays as parsed; other text is clipped. */
export function toError(res: TextResponse): BarakoError {
  let body: unknown;
  let message = `${res.status} ${res.statusText}`;
  if (res.text) {
    try {
      body = JSON.parse(res.text);
      const m = (body as { message?: unknown })?.message;
      if (typeof m === "string" && m) message = m;
    } catch {
      body = clip(res.text);
      message = body as string;
    }
  }
  return new BarakoError(res.status, message, body);
}

/** The per-call fields of a RequestOptions, taken from a CallOptions. */
export function callOpts(opts?: CallOptions): CallOptions {
  return { signal: opts?.signal, timeoutMs: opts?.timeoutMs };
}
