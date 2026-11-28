import { describe, expect, it } from "vitest";
import { until } from "./until";

/** A clock that only the injected sleep moves, so the tests take no real time. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("until", () => {
  it("returns the first value the check accepts", async () => {
    let n = 0;
    const v = await until("count", async () => ++n, (x) => x === 3, { timeoutMs: 1000, intervalMs: 10, ...clock() });
    expect(v).toBe(3);
  });

  it("goes on after a read that throws once", async () => {
    let n = 0;
    const v = await until(
      "OnHand",
      async () => {
        if (++n === 1) throw new Error("get_entry returned an error reply");
        return 7;
      },
      (x) => x === 7,
      { timeoutMs: 1000, intervalMs: 10, ...clock() },
    );
    expect(v).toBe(7);
    expect(n).toBe(2);
  });

  it("fails at the deadline naming the last error when every read throws", async () => {
    let n = 0;
    const c = clock();
    const run = until(
      "OnHand",
      async () => {
        throw new Error(`error reply ${++n}`);
      },
      () => true,
      { timeoutMs: 100, intervalMs: 10, ...c },
    );
    await expect(run).rejects.toThrow(/OnHand did not settle in 0\.1 s\. Last error: error reply \d+/);
    expect(n).toBeGreaterThan(1);
    expect(c.now()).toBeLessThanOrEqual(100);
  });

  it("fails at the deadline naming the last value when the value never qualifies", async () => {
    await expect(until("OnHand", async () => 5, (x) => x === 7, { timeoutMs: 50, intervalMs: 10, ...clock() })).rejects.toThrow("Last value: 5");
  });

  it("names the error when the last read threw after a value that did not qualify", async () => {
    let n = 0;
    const run = until(
      "OnHand",
      async () => {
        if (++n === 1) return 5;
        throw new Error("gone");
      },
      (x) => x === 7,
      { timeoutMs: 50, intervalMs: 10, ...clock() },
    );
    await expect(run).rejects.toThrow("Last error: gone");
  });

  it("makes a single read when the timeout is shorter than the interval", async () => {
    let n = 0;
    await expect(until("x", async () => ++n, () => false, { timeoutMs: 5, intervalMs: 10, ...clock() })).rejects.toThrow("did not settle");
    expect(n).toBe(1);
  });
});
