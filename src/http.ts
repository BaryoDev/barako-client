import { BarakoError } from "./errors";

/** Per-call options on the methods that accept them. */
export interface CallOptions {
  /** Abort this call. The error has code `aborted`. */
  signal?: AbortSignal;
  /** Timeout for this call in milliseconds, covering headers and body. 0 turns it off. Overrides the
   *  client's read or write default for this call. At most 2147483647 (about 24.8 days), larger or
   *  negative values throw before any request. The timeout applies to each attempt, not to the whole
   *  call: when a 401 starts a token refresh, the wait for the refresh and the retry each get the full
   *  timeout, so a call can take up to three times as long. Leaving the wait for a shared refresh only
   *  ends this call, not the refresh. */
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
  for (const field of ["readMs", "writeMs"] as const) checkTimeout(`createClient: timeouts.${field}`, out[field]);
  return out;
}

/** Throws unless `v` is 0 or a positive finite number of at most 2147483647 ms (about 24.8 days, the
 *  longest a single timer can wait). `label` names the setting in the message. */
function checkTimeout(label: string, v: unknown): asserts v is number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_TIMER_MS) {
    throw new Error(`${label} must be 0 or a number of milliseconds up to ${MAX_TIMER_MS}.`);
  }
}

// setTimeout fires at once for anything above this, so a larger timeout is rejected, not clamped.
const MAX_TIMER_MS = 2_147_483_647;

/** A response whose body was read under the same timeout as the headers. */
export interface TextResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
  text: string;
}

/** The effective timeout: the per-call value when given, else the default. A per-call value that
 *  config would reject throws, so a bad number is never ignored. */
export function resolveTimeout(perCall: number | undefined, fallback: number): number {
  if (perCall === undefined) return fallback;
  checkTimeout("timeoutMs", perCall);
  return perCall;
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
  limits: { signals: Array<AbortSignal | undefined>; timeoutMs: number; read?: boolean },
): Promise<TextResponse> {
  const writes = !(limits.read ?? isRead(init.method));
  const unknownNote = writes ? " The outcome is unknown, the server may have applied the request." : "";
  // An abort before fetch started cannot have reached the server, so only then is the outcome known.
  let started = false;
  const failure = (status: number, message: string, code: "timeout" | "aborted" | "network") => {
    const unknown = writes && (code !== "aborted" || started);
    return new BarakoError(status, unknown && code === "aborted" ? message + unknownNote : message, undefined, {
      code,
      outcomeUnknown: unknown,
    });
  };

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
        limits.timeoutMs,
      );
    }

    const work = (async (): Promise<TextResponse> => {
      started = true;
      const res = await fetchImpl(url, { ...init, signal: controller.signal });
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        // The status line already arrived. A failed body on an error response still has a real status.
        if (res.ok) throw e;
        text = "";
      }
      return { status: res.status, statusText: res.statusText, ok: res.ok, headers: res.headers, text };
    })();
    work.catch(() => {}); // when stop wins, the late rejection is ignored
    return await Promise.race([work, stop]);
  } catch (e) {
    if (e instanceof BarakoError) throw e;
    // The reason comes from the fetch implementation, so it is scrubbed, bounded and kept to one line.
    const reason = clip(scrubUrls(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim());
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

/** Replaces `scheme://user:pass@` with `scheme://***@`, so a URL with credentials in an error text
 *  does not leak them. */
export function scrubUrls(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\/\s]+@/gi, "$1***@");
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

/**
 * Waits for `work`, but gives up for this caller when one of its signals fires or its deadline
 * passes. `work` itself is not cancelled, so other callers sharing it still get its result. Rejects
 * with BarakoError code `aborted` or `timeout`, the text starting with `prefix`.
 */
export function waitBounded<T>(
  work: Promise<T>,
  limits: { signals: Array<AbortSignal | undefined>; timeoutMs?: number },
  prefix: string,
): Promise<T> {
  const attached: AbortSignal[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let leave!: (e: BarakoError) => void;
  const left = new Promise<never>((_, reject) => {
    leave = reject;
  });
  const aborted = () => new BarakoError(0, `${prefix} The request was aborted.`, undefined, { code: "aborted" });
  const onAbort = () => leave(aborted());
  for (const signal of limits.signals) {
    if (!signal) continue;
    if (signal.aborted) {
      for (const a of attached) a.removeEventListener("abort", onAbort);
      work.catch(() => {});
      return Promise.reject(aborted());
    }
    signal.addEventListener("abort", onAbort, { once: true });
    attached.push(signal);
  }
  const ms = limits.timeoutMs;
  if (ms !== undefined && ms > 0) {
    timer = setTimeout(
      () => leave(new BarakoError(0, `${prefix} The request timed out after ${ms} ms.`, undefined, { code: "timeout" })),
      ms,
    );
  }
  left.catch(() => {});
  return Promise.race([work, left]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    for (const signal of attached) signal.removeEventListener("abort", onAbort);
  });
}

/** The per-call fields of a RequestOptions, taken from a CallOptions. */
export function callOpts(opts?: CallOptions): CallOptions {
  return { signal: opts?.signal, timeoutMs: opts?.timeoutMs };
}

/** True for `localhost`, any `127.x.x.x` address and `[::1]`, the hosts where plain http stays on the machine. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "[::1]" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Returns a check that throws when a credential would travel over plain http to a host that is not
 * loopback, unless `allow` is set. A URL that is not absolute (a browser path) or is not http always
 * passes. Call the check before anything that carries a credential.
 */
export function plainHttpGuard(baseUrl: string, allow: boolean | undefined): () => void {
  let refuse = false;
  if (!allow) {
    try {
      const u = new URL(baseUrl);
      refuse = u.protocol === "http:" && !isLoopbackHost(u.hostname);
    } catch {
      refuse = false;
    }
  }
  return () => {
    if (refuse) {
      throw new Error(
        "Refusing to send a credential over plain http to a host that is not loopback. Use https, or set allowInsecureHttp: true if the network is trusted.",
      );
    }
  };
}
