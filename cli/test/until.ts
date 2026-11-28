// A bounded wait for the integration tests. Not a test file, so the unit run does not pick it up.

export interface UntilOptions {
  /** How long to keep reading. Default 120 s. */
  timeoutMs?: number;
  /** The pause between reads. Default 5 s. */
  intervalMs?: number;
  /** The clock, in ms. Tests inject one. */
  now?: () => number;
  /** The pause. Tests inject one that moves the clock. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Reads until `done` accepts the value. A read that throws, which is what an error reply from the stack
 * becomes, counts as not ready yet and is tried again. Gives up at the deadline and names the last thing
 * seen, the last value or the last error, whichever came later.
 */
export async function until<T>(what: string, read: () => Promise<T>, done: (v: T) => boolean, opts: UntilOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;
  let last = "nothing read";
  for (;;) {
    try {
      const v = await read();
      if (done(v)) return v;
      last = `Last value: ${JSON.stringify(v)}`;
    } catch (e) {
      last = `Last error: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (now() + intervalMs > deadline) throw new Error(`${what} did not settle in ${timeoutMs / 1000} s. ${last}`);
    await sleep(intervalMs);
  }
}
