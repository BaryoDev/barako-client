import { describe, expect, it } from "vitest";
import { checkContract } from "./check-contract";

function run(argv: string[], fetchImpl: typeof fetch, timeoutMs?: number) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const wrapped = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return fetchImpl(url, init);
  }) as unknown as typeof fetch;
  return checkContract(argv, { fetch: wrapped, stdout: (l) => out.push(l), stderr: (l) => err.push(l), timeoutMs }).then(
    (code) => ({ code, out, err, calls }),
  );
}

const answer = (headers: Record<string, string>, status = 200) =>
  (async () => new Response("{}", { status, headers })) as unknown as typeof fetch;

describe("check-contract", () => {
  it("exits 0 in range and names both surfaces", async () => {
    const r = await run(
      ["https://cms.test/api-root"],
      answer({ "X-Api-Contract-Version": "16", "X-Delivery-Contract-Version": "10" }),
    );
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    expect(r.out[0]).toContain("admin 16");
    expect(r.out[0]).toContain("delivery 10");
    expect(r.out[0]).toContain("supported 1 to 16");
  });

  it("does one GET to /api/meta with no auth", async () => {
    const r = await run(["https://cms.test/api-root/"], answer({ "X-Api-Contract-Version": "16" }));
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].url).toBe("https://cms.test/api-root/api/meta");
    expect(r.calls[0].init.method).toBe("GET");
    expect(r.calls[0].init.headers).toEqual({});
  });

  it("exits 1 when admin is outside the range", async () => {
    const r = await run(
      ["https://cms.test"],
      answer({ "X-Api-Contract-Version": "17", "X-Delivery-Contract-Version": "10" }),
    );
    expect(r.code).toBe(1);
    expect(r.out[0]).toContain("outside range");
    expect(r.out[0]).toContain("admin 17");
  });

  it("exits 1 when delivery is outside the range", async () => {
    const r = await run(
      ["https://cms.test"],
      answer({ "X-Api-Contract-Version": "16", "X-Delivery-Contract-Version": "11" }),
    );
    expect(r.code).toBe(1);
    expect(r.out[0]).toContain("delivery 11");
  });

  it("exits 1 when the header it needs is missing", async () => {
    const r = await run(["https://cms.test"], answer({}));
    expect(r.code).toBe(1);
    expect(r.out[0]).toContain("missing");
  });

  it("a value that is not a whole number counts as missing", async () => {
    const r = await run(["https://cms.test", "--surface", "admin"], answer({ "X-Api-Contract-Version": "12abc" }));
    expect(r.code).toBe(1);
    expect(r.out[0]).toContain("missing");
  });

  it("reads the headers whatever the status", async () => {
    const r = await run(
      ["https://cms.test"],
      answer({ "X-Api-Contract-Version": "16", "X-Delivery-Contract-Version": "10" }, 401),
    );
    expect(r.code).toBe(0);
  });

  it("exits 2 when the API cannot be reached", async () => {
    const r = await run(["https://cms.test"], (async () => {
      throw new TypeError("getaddrinfo ENOTFOUND cms.test");
    }) as unknown as typeof fetch);
    expect(r.code).toBe(2);
    expect(r.err[0]).toContain("cannot reach");
    expect(r.out).toHaveLength(0);
  });

  it("exits 2 on a timeout", async () => {
    const r = await run(["https://cms.test"], (() => new Promise<Response>(() => {})) as unknown as typeof fetch, 20);
    expect(r.code).toBe(2);
  });

  it("--surface delivery ignores the admin number", async () => {
    const r = await run(
      ["https://cms.test", "--surface", "delivery"],
      answer({ "X-Api-Contract-Version": "99", "X-Delivery-Contract-Version": "10" }),
    );
    expect(r.code).toBe(0);
    expect(r.out[0]).not.toContain("admin");
  });

  it("--surface admin ignores the delivery number", async () => {
    const r = await run(
      ["https://cms.test", "--surface=admin"],
      answer({ "X-Api-Contract-Version": "16", "X-Delivery-Contract-Version": "99" }),
    );
    expect(r.code).toBe(0);
  });

  it("an API from before the delivery split uses the admin number for delivery", async () => {
    const r = await run(["https://cms.test", "--surface", "delivery"], answer({ "X-Api-Contract-Version": "8" }));
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("delivery 8");
  });

  it("a missing url, a bad scheme or a bad surface is a usage error", async () => {
    for (const argv of [[], ["ftp://cms.test"], ["https://cms.test", "--surface", "x"], ["https://cms.test", "--nope"]]) {
      const r = await run(argv, answer({}));
      expect(r.code).toBe(2);
      expect(r.err[0]).toContain("usage:");
      expect(r.calls).toHaveLength(0);
    }
  });
});
