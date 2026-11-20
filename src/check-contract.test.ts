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
    expect(r.out[0]).toContain("in range");
  });

  it("does one GET to /api/meta with no auth", async () => {
    const r = await run(["https://cms.test/api-root/"], answer({ "X-Api-Contract-Version": "16" }));
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].url).toBe("https://cms.test/api-root/api/meta");
    expect(r.calls[0].init.method).toBe("GET");
    expect(r.calls[0].init.headers).toEqual({});
  });

  it("a newer admin number exits 0 and the line says newer", async () => {
    const r = await run(
      ["https://cms.test"],
      answer({ "X-Api-Contract-Version": "17", "X-Delivery-Contract-Version": "10" }),
    );
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("newer than this client");
    expect(r.out[0]).toContain("admin 17");
  });

  it("a newer delivery number exits 0 and the line says newer", async () => {
    const r = await run(
      ["https://cms.test"],
      answer({ "X-Api-Contract-Version": "16", "X-Delivery-Contract-Version": "11" }),
    );
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("newer than this client");
    expect(r.out[0]).toContain("delivery 11");
  });

  it("--strict makes a newer API exit 1", async () => {
    const r = await run(
      ["https://cms.test", "--strict"],
      answer({ "X-Api-Contract-Version": "17", "X-Delivery-Contract-Version": "10" }),
    );
    expect(r.code).toBe(1);
    expect(r.out[0]).toContain("newer than this client");
  });

  it("--strict leaves an in-range API at exit 0", async () => {
    const r = await run(
      ["https://cms.test", "--strict"],
      answer({ "X-Api-Contract-Version": "16", "X-Delivery-Contract-Version": "10" }),
    );
    expect(r.code).toBe(0);
  });

  it("an API older than the minimum exits 1", async () => {
    const r = await run(
      ["https://cms.test"],
      answer({ "X-Api-Contract-Version": "0", "X-Delivery-Contract-Version": "10" }),
    );
    expect(r.code).toBe(1);
    expect(r.out[0]).toContain("older than this client");
  });

  it("older wins over newer in the verdict", async () => {
    const r = await run(
      ["https://cms.test"],
      answer({ "X-Api-Contract-Version": "17", "X-Delivery-Contract-Version": "0" }),
    );
    expect(r.code).toBe(1);
    expect(r.out[0]).toContain("older than this client");
  });

  it("exits 1 when the header it needs is missing", async () => {
    for (const argv of [["https://cms.test"], ["https://cms.test", "--strict"]]) {
      const r = await run(argv, answer({}));
      expect(r.code).toBe(1);
      expect(r.out[0]).toContain("missing header");
    }
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

  it("the unreachable line is one printable line of bounded length", async () => {
    const r = await run(["https://cms.test"], (async () => {
      throw new TypeError("bad\nline\u0007 " + "x".repeat(500));
    }) as unknown as typeof fetch);
    expect(r.code).toBe(2);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).not.toMatch(/[^\x20-\x7e]/);
    expect(r.err[0].length).toBeLessThan(260);
  });

  it("a 5xx with no contract header exits 2 and the line says the status", async () => {
    for (const status of [502, 503]) {
      const r = await run(["https://cms.test"], answer({}, status));
      expect(r.code).toBe(2);
      expect(r.err[0]).toContain(String(status));
      expect(r.out).toHaveLength(0);
    }
  });

  it("a 2xx or 4xx with no contract header exits 1", async () => {
    for (const status of [200, 404]) {
      const r = await run(["https://cms.test"], answer({}, status));
      expect(r.code).toBe(1);
      expect(r.out[0]).toContain("missing header");
    }
  });

  it("a 5xx that carries the header is read as usual", async () => {
    const r = await run(["https://cms.test"], answer({ "X-Api-Contract-Version": "16", "X-Delivery-Contract-Version": "10" }, 500));
    expect(r.code).toBe(0);
  });

  it("a URL with a user or password is a usage error and nothing is sent or printed back", async () => {
    for (const url of ["https://user:SECRETPW@cms.test", "https://user@cms.test"]) {
      const r = await run([url], answer({ "X-Api-Contract-Version": "16" }));
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
      expect(r.err.join("\n")).not.toContain("SECRETPW");
      expect(r.err[0]).toContain("user or password");
    }
  });

  it("a credentials error from fetch is scrubbed in the unreachable line", async () => {
    const r = await run(["https://cms.test"], (async () => {
      throw new TypeError("includes credentials: https://user:SECRETPW@cms.test/api/meta");
    }) as unknown as typeof fetch);
    expect(r.err[0]).toContain("https://***@cms.test");
    expect(r.err[0]).not.toContain("SECRETPW");
  });

  it("keeps the path, drops the query and fragment, and adds /api/meta", async () => {
    const r = await run(["https://cms.test/root/v1/?x=1&y=2#top"], answer({ "X-Api-Contract-Version": "16" }));
    expect(r.calls[0].url).toBe("https://cms.test/root/v1/api/meta");
  });

  it("exits 2 on a timeout", async () => {
    const r = await run(["https://cms.test"], (() => new Promise<Response>(() => {})) as unknown as typeof fetch, 20);
    expect(r.code).toBe(2);
  });

  it("--surface delivery ignores the admin number", async () => {
    const r = await run(
      ["https://cms.test", "--surface", "delivery"],
      answer({ "X-Api-Contract-Version": "0", "X-Delivery-Contract-Version": "10" }),
    );
    expect(r.code).toBe(0);
    expect(r.out[0]).not.toContain("admin");
  });

  it("--surface admin ignores the delivery number", async () => {
    const r = await run(
      ["https://cms.test", "--surface=admin"],
      answer({ "X-Api-Contract-Version": "16", "X-Delivery-Contract-Version": "0" }),
    );
    expect(r.code).toBe(0);
  });

  it("an API from before the delivery split uses the admin number for delivery", async () => {
    const r = await run(["https://cms.test", "--surface", "delivery"], answer({ "X-Api-Contract-Version": "8" }));
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("delivery 8");
  });

  it("a missing url, a bad scheme or a bad surface is a usage error", async () => {
    for (const argv of [[], ["ftp://cms.test"], ["https://cms.test", "--surface", "x"], ["https://cms.test", "--nope"], ["https://cms.test", "https://other.test"]]) {
      const r = await run(argv, answer({}));
      expect(r.code).toBe(2);
      expect(r.err[0]).toContain("usage:");
      expect(r.calls).toHaveLength(0);
    }
  });
});
