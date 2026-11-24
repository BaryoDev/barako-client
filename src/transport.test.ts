import { afterEach, describe, expect, it, vi } from "vitest";
import { BarakoError, ContentStatus, createClient, memoryStore } from "./index";
import { waitBounded } from "./http";

const BASE = "https://cms.test/barakocms-api";

type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };

/** Replays programmed responses in order and records every call. */
function mockFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = replies[Math.min(i++, replies.length - 1)];
    const payload = r.text ?? (r.body !== undefined ? JSON.stringify(r.body) : "");
    return new Response(payload === "" ? null : payload, { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return Object.assign(fn, { calls });
}

/** A fetch that never answers and ignores its signal. */
function hangingFetch() {
  const calls: unknown[] = [];
  const fn = ((url: string) => {
    calls.push(url);
    return new Promise<Response>(() => {});
  }) as unknown as typeof fetch;
  return Object.assign(fn, { calls });
}

function b64url(o: unknown): string {
  return btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: "HS256" })}.${b64url(claims)}.sig`;

const page = { items: [], page: 1, pageSize: 10, totalCount: 0 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("timeouts", () => {
  it("a fetch that never resolves rejects with code timeout within the timeout", async () => {
    const cms = createClient({ baseUrl: BASE, fetch: hangingFetch(), timeouts: { readMs: 30, writeMs: 30 } });
    const started = Date.now();
    const err = await cms.public.list("post").catch((e) => e);
    expect(err).toBeInstanceOf(BarakoError);
    expect(err).toMatchObject({ status: 0, code: "timeout" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("a body that never finishes also times out", async () => {
    const stalled = (async () =>
      new Response(new ReadableStream({ start() {} }), { status: 200 })) as unknown as typeof fetch;
    const cms = createClient({ baseUrl: BASE, fetch: stalled, timeouts: { readMs: 30, writeMs: 30 } });
    await expect(cms.public.list("post")).rejects.toMatchObject({ code: "timeout" });
  });

  it("a GET with the defaults times out at 30000 ms", async () => {
    vi.useFakeTimers();
    const cms = createClient({ baseUrl: BASE, fetch: hangingFetch() });
    const result = cms.public.list("post").catch((e) => e);
    await vi.advanceTimersByTimeAsync(29_999);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ code: "timeout" });
  });

  it("a POST with the defaults leaves no timer", async () => {
    vi.useFakeTimers();
    const cms = createClient({ baseUrl: BASE, apiKey: "k", fetch: hangingFetch() });
    void cms.contents.create({ contentType: "post", data: {} }).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a POST with the defaults is still pending after an hour", async () => {
    vi.useFakeTimers();
    const cms = createClient({ baseUrl: BASE, apiKey: "k", fetch: hangingFetch() });
    let settled = false;
    void cms.contents.create({ contentType: "post", data: {} }).then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(settled).toBe(false);
  });

  it("readMs 0 leaves no timer on a GET", async () => {
    vi.useFakeTimers();
    const cms = createClient({ baseUrl: BASE, fetch: mockFetch([{ body: page }]), timeouts: { readMs: 0 } });
    const pending = cms.public.list("post");
    expect(vi.getTimerCount()).toBe(0);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a finished request leaves no timer behind", async () => {
    vi.useFakeTimers();
    const cms = createClient({ baseUrl: BASE, fetch: mockFetch([{ body: page }]), timeouts: { readMs: 5000 } });
    await cms.public.list("post");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("config readMs applies to a GET and not to a POST", async () => {
    const cms = createClient({ baseUrl: BASE, apiKey: "k", fetch: hangingFetch(), timeouts: { readMs: 20 } });
    await expect(cms.contents.list()).rejects.toMatchObject({ code: "timeout" });
    vi.useFakeTimers();
    let settled = false;
    void cms.contents.create({ contentType: "post", data: {} }).then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);
  });

  it("config writeMs applies to a POST and not to a GET", async () => {
    const cms = createClient({ baseUrl: BASE, apiKey: "k", fetch: hangingFetch(), timeouts: { writeMs: 20 } });
    await expect(cms.contents.create({ contentType: "post", data: {} })).rejects.toMatchObject({
      code: "timeout",
      outcomeUnknown: true,
    });
    vi.useFakeTimers();
    let settled = false;
    void cms.contents.list().then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(29_000);
    expect(settled).toBe(false);
  });

  it("a per-request timeoutMs overrides the client's read default", async () => {
    const cms = createClient({ baseUrl: BASE, fetch: hangingFetch(), timeouts: { readMs: 0 } });
    await expect(cms.public.list("post", undefined, { timeoutMs: 20 })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("a per-call timeoutMs on contents.create overrides writeMs", async () => {
    const cms = createClient({ baseUrl: BASE, apiKey: "k", fetch: hangingFetch(), timeouts: { writeMs: 0 } });
    await expect(
      cms.contents.create({ contentType: "post", data: {} }, { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "timeout", outcomeUnknown: true });
  });

  it("a per-call timeoutMs of 0 turns the read default off", async () => {
    vi.useFakeTimers();
    const cms = createClient({ baseUrl: BASE, fetch: hangingFetch() });
    let settled = false;
    void cms.public.list("post", undefined, { timeoutMs: 0 }).then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(settled).toBe(false);
  });

  it("a per-call signal and timeoutMs reach public.bySlug and public.menu", async () => {
    const cms = createClient({ baseUrl: BASE, fetch: hangingFetch(), timeouts: { readMs: 0 } });
    await expect(cms.public.bySlug("post", "a", { timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
    await expect(cms.public.menu("main", { timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
    const ctl = new AbortController();
    const a = cms.public.bySlug("post", "a", { signal: ctl.signal });
    const b = cms.public.menu("main", { signal: ctl.signal });
    ctl.abort();
    await expect(a).rejects.toMatchObject({ code: "aborted" });
    await expect(b).rejects.toMatchObject({ code: "aborted" });
  });

  it("a per-call timeoutMs reaches every method of every other resource", async () => {
    const t = { timeoutMs: 20 };
    const cms = createClient({ baseUrl: BASE, apiKey: "k", fetch: hangingFetch(), timeouts: { readMs: 0 } });
    const calls = [
      cms.contents.list(undefined, t),
      cms.contents.get("a", t),
      cms.contents.bySlug("post", "a", t),
      cms.contents.create({ contentType: "post", data: {} }, t),
      cms.contents.update("a", { data: {} }, t),
      cms.contents.transition("a", "go", undefined, t),
      cms.contents.schedule("a", { publishAt: null, unpublishAt: null }, t),
      cms.contents.rollback("a", "v1", t),
      cms.contents.erase("a", t),
      cms.contents.setStatus("a", ContentStatus.Published, t),
      cms.contents.history("a", t),
      cms.contentTypes.list(t),
      cms.contentTypes.create({ name: "post", fields: [] } as never, t),
      cms.contentTypes.readable(t),
      cms.contentTypes.get("post", t),
      cms.blocks.schema(t),
      cms.pages.tree(t),
      cms.me.tenants(t),
      cms.me.switch("t", t),
      cms.auth.login("u", "p", undefined, t),
      cms.auth.logout(t),
    ];
    for (const c of calls) await expect(c).rejects.toMatchObject({ code: "timeout" });
  });

  it("auth.refresh takes per-call options", async () => {
    const cms = createClient({
      baseUrl: BASE,
      token: jwt({ tenant: "a" }),
      refreshToken: "r1",
      fetch: hangingFetch(),
      timeouts: { readMs: 0 },
    });
    await expect(cms.auth.refresh({ timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("auth.refresh with no options takes readMs, times out, keeps the tokens and says the outcome is unknown", async () => {
    vi.useFakeTimers();
    const store = memoryStore({ token: jwt({ tenant: "a" }), refreshToken: "r1" });
    const cms = createClient({ baseUrl: BASE, storage: store, fetch: hangingFetch() });
    const result = cms.auth.refresh().catch((e) => e);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ code: "timeout", status: 0, outcomeUnknown: true });
    expect(store.get().refreshToken).toBe("r1");
  });

  it("a negative or non-finite readMs or writeMs throws and names the field", () => {
    for (const field of ["readMs", "writeMs"] as const) {
      for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() =>
          createClient({ baseUrl: BASE, fetch: hangingFetch(), timeouts: { [field]: bad } }),
        ).toThrow(new RegExp(`timeouts\\.${field}`));
      }
    }
  });

  it("a POST that times out says the outcome is unknown, and is sent once", async () => {
    const f = hangingFetch();
    const cms = createClient({ baseUrl: BASE, apiKey: "bcms_k", fetch: f, timeouts: { readMs: 20, writeMs: 20 } });
    const err = await cms.contents.create({ contentType: "post", data: {} }).catch((e) => e);
    expect(err).toMatchObject({ code: "timeout", status: 0, outcomeUnknown: true });
    expect(err.message).toMatch(/outcome is unknown/);
    expect(f.calls).toHaveLength(1);
  });

  it("a GET that times out is not marked unknown", async () => {
    const cms = createClient({ baseUrl: BASE, fetch: hangingFetch(), timeouts: { readMs: 20, writeMs: 20 } });
    const err = await cms.public.list("post").catch((e) => e);
    expect(err.message).toMatch(/timed out after 20 ms/);
    expect(err.outcomeUnknown).toBeUndefined();
    expect(err.message).not.toMatch(/unknown/);
  });

  it("a timeout above the timer limit is rejected in config, and the limit itself is kept whole", async () => {
    for (const field of ["readMs", "writeMs"] as const) {
      expect(() =>
        createClient({ baseUrl: BASE, fetch: hangingFetch(), timeouts: { [field]: 2_147_483_648 } }),
      ).toThrow(new RegExp(`timeouts\\.${field} must be 0 or a number of milliseconds up to 2147483647`));
    }
    const spy = vi.spyOn(globalThis, "setTimeout");
    const cms = createClient({ baseUrl: BASE, fetch: mockFetch([{ body: page }]), timeouts: { readMs: 2_147_483_647 } });
    await cms.public.list("post");
    expect(Math.max(...spy.mock.calls.map((c) => Number(c[1])))).toBe(2_147_483_647);
  });

  it("a per-call timeoutMs above the timer limit throws before any request", async () => {
    const f = hangingFetch();
    const cms = createClient({ baseUrl: BASE, fetch: f });
    await expect(cms.public.list("post", undefined, { timeoutMs: 3_000_000_000 })).rejects.toThrow(
      /timeoutMs must be 0 or a number of milliseconds up to 2147483647/,
    );
    expect(f.calls).toHaveLength(0);
  });

  it("a timeout aborts the signal given to fetch and still reports timeout, not network", async () => {
    let seen: AbortSignal | undefined;
    const f = ((_url: string, init: RequestInit) => {
      seen = init.signal as AbortSignal;
      return new Promise<Response>((_, reject) => {
        seen!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    const cms = createClient({ baseUrl: BASE, fetch: f, timeouts: { readMs: 20 } });
    await expect(cms.public.list("post")).rejects.toMatchObject({ code: "timeout" });
    expect(seen!.aborted).toBe(true);
  });

  it("a POST that loses its connection says the outcome is unknown and is not retried", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const cms = createClient({ baseUrl: BASE, apiKey: "bcms_k", fetch: f });
    const err = await cms.contents.create({ contentType: "post", data: {} }).catch((e) => e);
    expect(err).toMatchObject({ code: "network", status: 0, outcomeUnknown: true });
    expect(err.message).toContain("Network error: fetch failed");
    expect(err.message).toContain("The outcome is unknown, the server may have applied the request.");
    expect(n).toBe(1);
  });
});

describe("requests that save nothing", () => {
  const calls: Array<[string, (cms: ReturnType<typeof createClient>) => Promise<unknown>]> = [
    ["auth.login", (c) => c.auth.login("u", "p")],
    ["auth.logout", (c) => c.auth.logout()],
    ["me.switch", (c) => c.me.switch("t")],
    ["contents.create with dryRun", (c) => c.contents.create({ contentType: "post", data: {} }, { dryRun: true })],
    ["contents.update with dryRun", (c) => c.contents.update("a", { data: {} }, { dryRun: true })],
  ];

  it("login, logout, switch and the dry runs take the read default of 30000 ms", async () => {
    vi.useFakeTimers();
    for (const [name, call] of calls) {
      const cms = createClient({ baseUrl: BASE, fetch: hangingFetch() });
      const result = call(cms).catch((e) => e);
      await vi.advanceTimersByTimeAsync(29_999);
      let settled = false;
      void result.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled, name).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const err = (await result) as BarakoError;
      expect(err, name).toMatchObject({ code: "timeout" });
      expect(err.outcomeUnknown, name).toBeUndefined();
      expect(err.message, name).not.toMatch(/outcome/);
    }
  });

  it("a timed out dry run does not say the outcome is unknown", async () => {
    const cms = createClient({ baseUrl: BASE, apiKey: "k", fetch: hangingFetch(), timeouts: { readMs: 20 } });
    const err = await cms.contents.create({ contentType: "post", data: {} }, { dryRun: true }).catch((e) => e);
    expect(err).toMatchObject({ code: "timeout" });
    expect(err.outcomeUnknown).toBeUndefined();
    expect(err.message).not.toMatch(/outcome/);
  });

  it("a real create still takes the write default and says the outcome is unknown", async () => {
    const cms = createClient({ baseUrl: BASE, apiKey: "k", fetch: hangingFetch(), timeouts: { readMs: 20, writeMs: 40 } });
    const err = await cms.contents.create({ contentType: "post", data: {} }).catch((e) => e);
    expect(err.message).toMatch(/after 40 ms/);
    expect(err.message).toMatch(/outcome is unknown/);
  });
});

describe("per-call timeoutMs that config would reject", () => {
  it("a negative, NaN, Infinity or non-number timeoutMs throws before any request", async () => {
    const f = hangingFetch();
    const cms = createClient({ baseUrl: BASE, fetch: f });
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "5", null]) {
      await expect(cms.public.list("post", undefined, { timeoutMs: bad as never })).rejects.toThrow(
        /timeoutMs must be 0 or a number of milliseconds up to 2147483647/,
      );
    }
    expect(f.calls).toHaveLength(0);
  });
});

describe("network error text", () => {
  const failing = (message: string) =>
    (async () => {
      throw new TypeError(message);
    }) as unknown as typeof fetch;

  it("scrubs credentials from a URL in the reason", async () => {
    const cms = createClient({
      baseUrl: BASE,
      fetch: failing("Request cannot be constructed from a URL that includes credentials: https://user:SECRETPW@cms.test/x"),
    });
    const err = await cms.public.list("post").catch((e) => e);
    expect(err.message).toContain("https://***@cms.test/x");
    expect(err.message).not.toContain("SECRETPW");
  });

  it("cuts a long multi-line reason to one bounded line", async () => {
    const cms = createClient({ baseUrl: BASE, fetch: failing(`boom\nsecond line\n${"y".repeat(3000)}`) });
    const err = await cms.public.list("post").catch((e) => e);
    expect(err.message).not.toMatch(/[\r\n]/);
    expect(err.message.length).toBeLessThan(600);
    expect(err.message).toContain("boom second line");
  });
});

describe("baseUrl with credentials", () => {
  it("createClient throws a config error", () => {
    expect(() => createClient({ baseUrl: "https://user:pw@cms.test/api" })).toThrow(/baseUrl must not contain a user or password/);
    expect(() => createClient({ baseUrl: "https://user@cms.test/api" })).toThrow(/baseUrl must not contain/);
  });

  it("the error does not repeat the password", () => {
    try {
      createClient({ baseUrl: "https://user:SECRETPW@cms.test/api" });
    } catch (e) {
      expect((e as Error).message).not.toContain("SECRETPW");
    }
  });
});

describe("abort signals", () => {
  it("a per-request signal aborts with code aborted", async () => {
    const ctl = new AbortController();
    const cms = createClient({ baseUrl: BASE, fetch: hangingFetch(), timeouts: { readMs: 0, writeMs: 0 } });
    const pending = cms.public.list("post", undefined, { signal: ctl.signal });
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted", status: 0 });
  });

  it("a signal that is already aborted never reaches fetch", async () => {
    const f = hangingFetch();
    const cms = createClient({ baseUrl: BASE, fetch: f, timeouts: { readMs: 0, writeMs: 0 } });
    await expect(cms.public.list("post", undefined, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: "aborted",
    });
    expect(f.calls).toHaveLength(0);
  });

  it("an abort of a POST after fetch started says the outcome is unknown", async () => {
    const f = hangingFetch();
    const ctl = new AbortController();
    const cms = createClient({ baseUrl: BASE, apiKey: "k", fetch: f });
    const pending = cms.contents.create({ contentType: "post", data: {} }, { signal: ctl.signal });
    ctl.abort();
    const err = await pending.catch((e) => e);
    expect(f.calls).toHaveLength(1);
    expect(err).toMatchObject({ code: "aborted", status: 0, outcomeUnknown: true });
    expect(err.message).toContain("The outcome is unknown, the server may have applied the request.");
  });

  it("an abort of a PUT, PATCH or DELETE after fetch started says the outcome is unknown", async () => {
    const cms = createClient({ baseUrl: BASE, apiKey: "k", fetch: hangingFetch() });
    for (const call of [
      (signal: AbortSignal) => cms.contents.update("a", { data: {} }, { signal }),
      (signal: AbortSignal) => cms.contents.setStatus("a", ContentStatus.Published, { signal }),
      (signal: AbortSignal) => cms.contents.erase("a", { signal }),
    ]) {
      const ctl = new AbortController();
      const pending = call(ctl.signal);
      ctl.abort();
      await expect(pending).rejects.toMatchObject({ code: "aborted", outcomeUnknown: true });
    }
  });

  it("an abort of a POST before fetch started does not say the outcome is unknown", async () => {
    const f = hangingFetch();
    const cms = createClient({ baseUrl: BASE, apiKey: "k", fetch: f });
    const err = await cms.contents.create({ contentType: "post", data: {} }, { signal: AbortSignal.abort() }).catch((e) => e);
    expect(f.calls).toHaveLength(0);
    expect(err).toMatchObject({ code: "aborted" });
    expect(err.outcomeUnknown).toBeUndefined();
    expect(err.message).not.toMatch(/outcome/);
  });

  it("an abort of a GET does not say the outcome is unknown", async () => {
    const ctl = new AbortController();
    const cms = createClient({ baseUrl: BASE, fetch: hangingFetch() });
    const pending = cms.public.list("post", undefined, { signal: ctl.signal });
    ctl.abort();
    const err = await pending.catch((e) => e);
    expect(err.outcomeUnknown).toBeUndefined();
    expect(err.message).toBe("The request was aborted.");
  });

  it("a config signal aborts with code aborted", async () => {
    const ctl = new AbortController();
    const cms = createClient({ baseUrl: BASE, fetch: hangingFetch(), timeouts: { readMs: 0, writeMs: 0 }, signal: ctl.signal });
    const pending = cms.public.list("post");
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("the signal is passed to fetch so a real fetch stops", async () => {
    const f = mockFetch([{ body: page }]);
    const cms = createClient({ baseUrl: BASE, fetch: f });
    await cms.public.list("post");
    expect(f.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("after 1000 requests the config signal has no listeners left", async () => {
    const ctl = new AbortController();
    let live = 0;
    const add = ctl.signal.addEventListener.bind(ctl.signal);
    const remove = ctl.signal.removeEventListener.bind(ctl.signal);
    ctl.signal.addEventListener = ((type: string, fn: never, o: never) => {
      if (type === "abort") live++;
      add(type, fn, o);
    }) as typeof ctl.signal.addEventListener;
    ctl.signal.removeEventListener = ((type: string, fn: never, o: never) => {
      if (type === "abort") live--;
      remove(type, fn, o);
    }) as typeof ctl.signal.removeEventListener;

    const cms = createClient({ baseUrl: BASE, fetch: mockFetch([{ body: page }]), signal: ctl.signal });
    for (let i = 0; i < 1000; i++) await cms.public.list("post");
    expect(live).toBe(0);
  });
});

describe("refresh that survives a transient failure", () => {
  const old = jwt({ tenant: "acme" });

  async function run(refreshReply: Reply | "network") {
    const store = memoryStore({ token: old, refreshToken: "r1" });
    let n = 0;
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      if (n++ === 0) return new Response(JSON.stringify({ message: "expired" }), { status: 401 });
      if (refreshReply === "network") throw new TypeError("fetch failed");
      return new Response(refreshReply.text ?? JSON.stringify(refreshReply.body ?? ""), {
        status: refreshReply.status ?? 200,
      });
    }) as unknown as typeof fetch;
    const cms = createClient({ baseUrl: BASE, storage: store, fetch: f });
    const err = await cms.contents.list().catch((e) => e);
    return { store, err, calls };
  }

  it("a 503 keeps both tokens and rejects with the 503", async () => {
    const { store, err } = await run({ status: 503, body: { message: "busy" } });
    expect(store.get()).toEqual({ token: old, refreshToken: "r1" });
    expect(err).toBeInstanceOf(BarakoError);
    expect(err.status).toBe(503);
  });

  it("a network error keeps both tokens and rejects with code network", async () => {
    const { store, err } = await run("network");
    expect(store.get()).toEqual({ token: old, refreshToken: "r1" });
    expect(err).toMatchObject({ status: 0, code: "network" });
  });

  it("a timeout keeps both tokens and rejects with code timeout", async () => {
    const store = memoryStore({ token: old, refreshToken: "r1" });
    let n = 0;
    const f = (() =>
      n++ === 0
        ? Promise.resolve(new Response("{}", { status: 401 }))
        : new Promise<Response>(() => {})) as unknown as typeof fetch;
    const cms = createClient({ baseUrl: BASE, storage: store, fetch: f, timeouts: { readMs: 20 } });
    const err = await cms.contents.list().catch((e) => e);
    expect(store.get()).toEqual({ token: old, refreshToken: "r1" });
    expect(err).toMatchObject({ status: 0, code: "timeout" });
  });

  it("the refresh POST uses readMs, not writeMs", async () => {
    const store = memoryStore({ token: old, refreshToken: "r1" });
    let n = 0;
    const f = (() =>
      n++ === 0
        ? Promise.resolve(new Response("{}", { status: 401 }))
        : new Promise<Response>(() => {})) as unknown as typeof fetch;
    // writeMs is 0 (no limit), so only readMs can end this refresh.
    const cms = createClient({ baseUrl: BASE, storage: store, fetch: f, timeouts: { readMs: 20, writeMs: 0 } });
    const err = await cms.contents.list().catch((e) => e);
    expect(err).toMatchObject({ code: "timeout" });
    expect(err.message).toMatch(/refresh/);
  });

  it("a 403 and a 429 keep the tokens", async () => {
    for (const status of [403, 429]) {
      const { store, err } = await run({ status, body: {} });
      expect(store.get()).toEqual({ token: old, refreshToken: "r1" });
      expect(err.status).toBe(status);
    }
  });

  it("a 400 clears the tokens", async () => {
    const { store, err } = await run({ status: 400, body: {} });
    expect(store.get()).toEqual({});
    expect(err.status).toBe(401);
  });

  it("a 401 clears the tokens", async () => {
    const { store, err } = await run({ status: 401, body: {} });
    expect(store.get()).toEqual({});
    expect(err.status).toBe(401);
  });

  it("a 200 refresh with an HTML body keeps the tokens and rejects with invalid-json", async () => {
    const { store, err } = await run({ status: 200, text: "<html>proxy</html>" });
    expect(store.get()).toEqual({ token: old, refreshToken: "r1" });
    expect(err).toMatchObject({ code: "invalid-json", status: 200 });
  });

  it("the client's signal covers the refresh fetch", async () => {
    const ctl = new AbortController();
    const store = memoryStore({ token: old, refreshToken: "r1" });
    let n = 0;
    const f = (() => {
      if (n++ === 0) return Promise.resolve(new Response("{}", { status: 401 }));
      queueMicrotask(() => ctl.abort());
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const cms = createClient({ baseUrl: BASE, storage: store, fetch: f, timeouts: { readMs: 0, writeMs: 0 }, signal: ctl.signal });
    const err = await cms.contents.list().catch((e) => e);
    expect(err).toMatchObject({ code: "aborted" });
    expect(store.get().refreshToken).toBe("r1");
  });

  it("a timed out request is never retried with a refresh", async () => {
    const f = hangingFetch();
    const cms = createClient({ baseUrl: BASE, token: old, refreshToken: "r1", fetch: f, timeouts: { readMs: 20, writeMs: 20 } });
    await expect(cms.contents.create({ contentType: "post", data: {} })).rejects.toMatchObject({ code: "timeout" });
    expect(f.calls).toHaveLength(1);
  });
});

describe("refresh details", () => {
  const old = jwt({ tenant: "acme" });

  /** A client whose first call gets a 401 and whose refresh answers with `refresh`. */
  function setup(refresh: (url: string) => Promise<Response>, config: { baseUrl?: string; readMs?: number } = {}) {
    const store = memoryStore({ token: old, refreshToken: "r1" });
    const urls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      urls.push(url);
      if (url.endsWith("/api/auth/refresh")) return refresh(url);
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === "Bearer n1" ? new Response(JSON.stringify(page), { status: 200 }) : new Response("{}", { status: 401 });
    }) as unknown as typeof fetch;
    const cms = createClient({
      baseUrl: config.baseUrl ?? BASE,
      storage: store,
      fetch: f,
      timeouts: { readMs: config.readMs ?? 2000 },
    });
    return { cms, store, urls };
  }

  /** Lets a test hold a refresh response until it chooses, and know when the refresh began. */
  function refreshGate() {
    let begin!: () => void;
    let open!: () => void;
    const started = new Promise<void>((r) => (begin = r));
    const opened = new Promise<void>((r) => (open = r));
    return {
      started,
      release: () => open(),
      hold: async (res: Response) => {
        begin();
        await opened;
        return res;
      },
    };
  }

  const fresh = () => new Response(JSON.stringify({ token: "n1", refreshToken: "r2" }), { status: 200 });

  it("a logout during the refresh is not undone by the refresh finishing", async () => {
    const gate = refreshGate();
    const { cms, store, urls } = setup(() => gate.hold(fresh()));
    const call = cms.contents.list().catch((e) => e);
    await gate.started;
    store.clear();
    gate.release();
    const err = await call;
    expect(err).toBeInstanceOf(BarakoError);
    expect(err.status).toBe(401);
    expect(store.get()).toEqual({});
    expect(urls.filter((u) => !u.endsWith("/api/auth/refresh"))).toHaveLength(1); // no retry
  });

  it("a login during the refresh is not replaced by the refresh finishing", async () => {
    const gate = refreshGate();
    const { cms, store } = setup(() => gate.hold(fresh()));
    const call = cms.contents.list().catch((e) => e);
    await gate.started;
    store.set({ token: "login", refreshToken: "rLogin" });
    gate.release();
    await call;
    expect(store.get()).toEqual({ token: "login", refreshToken: "rLogin" });
  });

  it("a login during a refresh that answers 401 is not signed out", async () => {
    const gate = refreshGate();
    const { cms, store } = setup(() => gate.hold(new Response("{}", { status: 401 })));
    const call = cms.contents.list().catch((e) => e);
    await gate.started;
    store.set({ token: "login", refreshToken: "rLogin" });
    gate.release();
    await call;
    expect(store.get()).toEqual({ token: "login", refreshToken: "rLogin" });
  });

  it("a refresh token replaced during the refresh is kept", async () => {
    const gate = refreshGate();
    const { cms, store } = setup(() => gate.hold(fresh()));
    const call = cms.contents.list().catch((e) => e);
    await gate.started;
    store.set({ refreshToken: "rOther" });
    gate.release();
    await call;
    expect(store.get()).toEqual({ token: old, refreshToken: "rOther" });
  });

  it("a tenant switch during the refresh keeps the switched token", async () => {
    const gate = refreshGate();
    const { cms, store } = setup(() => gate.hold(fresh()));
    const call = cms.contents.list().catch((e) => e);
    await gate.started;
    store.set({ token: "switched" });
    gate.release();
    await call;
    expect(store.get()).toEqual({ token: "switched", refreshToken: "r1" });
  });

  it("a caller's abort ends its wait at once and leaves the refresh to the other caller", async () => {
    let refreshes = 0;
    const gate = refreshGate();
    const { cms, store } = setup(async () => {
      refreshes++;
      return gate.hold(new Response(JSON.stringify({ token: "n1", refreshToken: "r2" }), { status: 200 }));
    });
    const ctl = new AbortController();
    const a = cms.contents.list(undefined, { signal: ctl.signal }).catch((e) => e);
    const b = cms.contents.list().catch((e) => e);
    await gate.started;
    ctl.abort();
    const errA = await a; // settles while the refresh is still held, so the abort ended only A's wait
    expect(errA).toMatchObject({ code: "aborted", status: 0 });
    expect(errA.message).toMatch(/^Token refresh failed\./);
    gate.release();
    const resB = await b;
    expect(resB).not.toBeInstanceOf(Error);
    expect(refreshes).toBe(1);
    expect(store.get()).toEqual({ token: "n1", refreshToken: "r2" });
  });

  it("a per-call timeoutMs ends the caller's wait for a hung refresh", async () => {
    const { cms, store } = setup(() => new Promise<Response>(() => {}), { readMs: 2000 });
    const err = await cms.contents.list(undefined, { timeoutMs: 50 }).catch((e) => e);
    expect(err).toMatchObject({ code: "timeout", status: 0 });
    expect(err.message).toMatch(/^Token refresh failed\. The request timed out after 50 ms/);
    expect(store.get().refreshToken).toBe("r1");
  });

  it("a refresh that answers 403 or 503 rejects with the refresh prefix and keeps its status", async () => {
    for (const status of [403, 503]) {
      const { cms, store } = setup(async () => new Response(JSON.stringify({ message: "nope" }), { status }));
      const err = await cms.contents.list().catch((e) => e);
      expect(err).toBeInstanceOf(BarakoError);
      expect(err.status).toBe(status);
      expect(err.message).toBe("Token refresh failed. nope");
      expect(store.get()).toEqual({ token: old, refreshToken: "r1" });
    }
  });

  it("a refresh 200 without a non-empty string token is invalid-json and the tokens stay", async () => {
    for (const answer of [{ refreshToken: "r2" }, { token: "", refreshToken: "r2" }, { token: 5, refreshToken: "r2" }]) {
      const { cms, store, urls } = setup(async () => new Response(JSON.stringify(answer), { status: 200 }));
      const err = await cms.contents.list().catch((e) => e);
      expect(err).toMatchObject({ code: "invalid-json", status: 200 });
      expect(JSON.stringify(err.body)).not.toContain("r2");
      expect(store.get()).toEqual({ token: old, refreshToken: "r1" });
      expect(urls).toHaveLength(2);
    }
  });

  it("a caller that waits for a refresh with a per-call timeoutMs leaves no timer behind", async () => {
    vi.useFakeTimers();
    const { cms } = setup(async () => new Response(JSON.stringify({ token: "n1", refreshToken: "r2" }), { status: 200 }));
    await cms.contents.list(undefined, { timeoutMs: 5000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waitBounded with an already aborted signal rejects and leaves no listener on the others", async () => {
    const live = new AbortController();
    let listeners = 0;
    const add = live.signal.addEventListener.bind(live.signal);
    const remove = live.signal.removeEventListener.bind(live.signal);
    live.signal.addEventListener = ((type: string, fn: never, o: never) => {
      listeners++;
      add(type, fn, o);
    }) as typeof live.signal.addEventListener;
    live.signal.removeEventListener = ((type: string, fn: never, o: never) => {
      listeners--;
      remove(type, fn, o);
    }) as typeof live.signal.removeEventListener;
    await expect(
      waitBounded(new Promise<never>(() => {}), { signals: [live.signal, AbortSignal.abort()] }, "Token refresh failed."),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(listeners).toBe(0);
  });

  it("a baseUrl with a trailing slash refreshes at /api/auth/refresh", async () => {
    const { cms, urls } = setup(
      async () => new Response(JSON.stringify({ token: "n1", refreshToken: "r2" }), { status: 200 }),
      { baseUrl: `${BASE}/` },
    );
    await cms.contents.list();
    expect(urls).toContain(`${BASE}/api/auth/refresh`);
    expect(urls.some((u) => u.includes("//api"))).toBe(false);
  });
});

describe("allPages", () => {
  const endless = () => {
    let n = 0;
    const fn = (async () => {
      n++;
      return new Response(JSON.stringify({ items: [{ slug: "a" }], page: n, pageSize: 100, totalCount: 0, hasNextPage: true }));
    }) as unknown as typeof fetch;
    return Object.assign(fn, { count: () => n });
  };

  it("stops after 1000 pages with an error that names the cap", async () => {
    const f = endless();
    const cms = createClient({ baseUrl: BASE, apiKey: "k", fetch: f });
    await expect(cms.me.tenants()).rejects.toThrow(/did not end after 1000 pages/);
    expect(f.count()).toBe(1000);
  });

  it("a per-call signal stops the whole loop", async () => {
    const ctl = new AbortController();
    let n = 0;
    const f = (async () => {
      if (++n === 3) ctl.abort();
      return new Response(JSON.stringify({ items: [{ slug: "a" }], hasNextPage: true }));
    }) as unknown as typeof fetch;
    const cms = createClient({ baseUrl: BASE, apiKey: "k", fetch: f });
    await expect(cms.me.tenants({ signal: ctl.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(n).toBe(3);
  });
});

describe("non-JSON bodies", () => {
  it("a 200 with an HTML body rejects with invalid-json and the response status", async () => {
    const cms = createClient({ baseUrl: BASE, fetch: mockFetch([{ status: 200, text: "<html>login</html>" }]) });
    const err = await cms.public.list("post").catch((e) => e);
    expect(err).toBeInstanceOf(BarakoError);
    expect(err).toMatchObject({ code: "invalid-json", status: 200 });
  });

  it("a 200 with a 5000 character non-JSON body is cut in its body", async () => {
    const cms = createClient({ baseUrl: BASE, fetch: mockFetch([{ status: 200, text: "x".repeat(5000) }]) });
    const err = await cms.public.list("post").catch((e) => e);
    expect(err.code).toBe("invalid-json");
    expect((err.body as string).length).toBeLessThanOrEqual(500);
    expect(err.message.length).toBeLessThanOrEqual(500);
  });

  it("a 502 with a 5000 character HTML body is cut in message and body", async () => {
    const html = "<html>" + "x".repeat(5000) + "</html>";
    const cms = createClient({ baseUrl: BASE, fetch: mockFetch([{ status: 502, text: html }]) });
    const err = await cms.public.list("post").catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message.length).toBeLessThanOrEqual(500);
    expect((err.body as string).length).toBeLessThanOrEqual(500);
    expect(err.message.endsWith("...")).toBe(true);
    expect(err.message.startsWith("<html>")).toBe(true);
  });

  it("a short non-JSON body is kept whole", async () => {
    const cms = createClient({ baseUrl: BASE, fetch: mockFetch([{ status: 502, text: "Bad Gateway" }]) });
    const err = await cms.public.list("post").catch((e) => e);
    expect(err.message).toBe("Bad Gateway");
    expect(err.body).toBe("Bad Gateway");
  });

  it("a JSON error body stays as parsed", async () => {
    const body = { message: "no", detail: "y".repeat(2000) };
    const cms = createClient({ baseUrl: BASE, fetch: mockFetch([{ status: 400, body }]) });
    const err = await cms.public.list("post").catch((e) => e);
    expect(err.message).toBe("no");
    expect(err.body).toEqual(body);
  });
});

describe("a body that fails to read", () => {
  const broken = (status: number) =>
    (async () =>
      new Response(new ReadableStream({ start: (c) => c.error(new Error("boom")) }), {
        status,
        statusText: "Forbidden",
      })) as unknown as typeof fetch;

  it("a non-2xx response keeps its status in a BarakoError with no code", async () => {
    const cms = createClient({ baseUrl: BASE, fetch: broken(403) });
    const err = await cms.public.list("post").catch((e) => e);
    expect(err).toBeInstanceOf(BarakoError);
    expect(err.status).toBe(403);
    expect(err.code).toBeUndefined();
    expect(err.message).toBe("403 Forbidden");
  });

  it("a 2xx response whose body fails is still a network error", async () => {
    const cms = createClient({ baseUrl: BASE, fetch: broken(200) });
    await expect(cms.public.list("post")).rejects.toMatchObject({ status: 0, code: "network" });
  });
});

describe("contract range", () => {
  const admin = (v: string) => ({ "X-Api-Contract-Version": v });

  it("admin 18 on an admin path warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cms = createClient({ baseUrl: BASE, apiKey: "k", fetch: mockFetch([{ body: page, headers: admin("18") }]) });
    await cms.contents.list();
    await cms.contents.list();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/admin contract 18/);
  });

  it("admin 17 on an admin path does not warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cms = createClient({ baseUrl: BASE, apiKey: "k", fetch: mockFetch([{ body: page, headers: admin("17") }]) });
    await cms.contents.list();
    expect(warn).not.toHaveBeenCalled();
  });

  it("delivery 11 on a public path warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cms = createClient({
      baseUrl: BASE,
      fetch: mockFetch([{ body: page, headers: { ...admin("16"), "X-Delivery-Contract-Version": "11" } }]),
    });
    await cms.public.list("post");
    await cms.public.list("post");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/delivery contract 11/);
  });

  it("admin 18 on a public path with delivery 10 does not warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cms = createClient({
      baseUrl: BASE,
      fetch: mockFetch([{ body: page, headers: { ...admin("18"), "X-Delivery-Contract-Version": "10" } }]),
    });
    await cms.public.list("post");
    expect(warn).not.toHaveBeenCalled();
  });

  it("an API from before the split uses the admin number for delivery", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cms = createClient({ baseUrl: BASE, fetch: mockFetch([{ body: page, headers: admin("12") }]) });
    await cms.public.list("post");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a delivery header that is present but not a whole number does not fall back to the admin number", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cms = createClient({
      baseUrl: BASE,
      fetch: mockFetch([{ body: page, headers: { ...admin("18"), "X-Delivery-Contract-Version": "12abc" } }]),
    });
    await cms.public.list("post");
    expect(warn).not.toHaveBeenCalled();
  });

  it("a missing header does not warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cms = createClient({ baseUrl: BASE, fetch: mockFetch([{ body: page }]) });
    await cms.public.list("post");
    expect(warn).not.toHaveBeenCalled();
  });

  it("a header that is not a whole number counts as missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const v of ["abc", "-1", "17.5", ""]) {
      const cms = createClient({ baseUrl: BASE, apiKey: "k", fetch: mockFetch([{ body: page, headers: admin(v) }]) });
      await cms.contents.list();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("a number below the range warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cms = createClient({ baseUrl: BASE, apiKey: "k", fetch: mockFetch([{ body: page, headers: admin("0") }]) });
    await cms.contents.list();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("onContractMismatch replaces the warning and gets the details", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: unknown[] = [];
    const cms = createClient({
      baseUrl: BASE,
      apiKey: "k",
      fetch: mockFetch([{ body: page, headers: admin("18") }]),
      onContractMismatch: (info) => seen.push(info),
    });
    await cms.contents.list();
    expect(warn).not.toHaveBeenCalled();
    expect(seen).toEqual([{ surface: "admin", apiVersion: 18, min: 1, max: 17 }]);
  });

  it("a mismatch is checked on an error response and does not change it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: unknown[] = [];
    const cms = createClient({
      baseUrl: BASE,
      apiKey: "k",
      fetch: mockFetch([{ status: 500, body: { message: "boom" }, headers: admin("18") }]),
      onContractMismatch: (info) => seen.push(info),
    });
    await expect(cms.contents.list()).rejects.toMatchObject({ status: 500, message: "boom" });
    expect(seen).toHaveLength(1);
  });

  it("a callback that throws does not change the result", async () => {
    const cms = createClient({
      baseUrl: BASE,
      apiKey: "k",
      fetch: mockFetch([{ body: page, headers: admin("18") }]),
      onContractMismatch: () => {
        throw new Error("bad callback");
      },
    });
    await expect(cms.contents.list()).resolves.toBeDefined();
  });
});
