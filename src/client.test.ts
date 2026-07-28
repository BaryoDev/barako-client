import { describe, it, expect } from "vitest";
import { createClient, BarakoError, tenantOfToken } from "./index";

// --- helpers ---------------------------------------------------------------

const BASE = "https://cms.test/barakocms-api";

/** A fake fetch that records calls and replays programmed responses in order. */
function mockFetch(responses: Array<{ status?: number; body?: unknown; text?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    const status = r.status ?? 200;
    const payload = r.text ?? (r.body !== undefined ? JSON.stringify(r.body) : "");
    // 204/205/304 must have a null body per the Response constructor.
    const nullBody = status === 204 || status === 205 || status === 304;
    return new Response(nullBody || payload === "" ? null : payload, { status });
  }) as unknown as typeof fetch;
  return Object.assign(fn, { calls });
}

function b64url(o: unknown): string {
  return btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function jwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "HS256" })}.${b64url(claims)}.sig`;
}
function authHeader(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string>)?.["Authorization"];
}
function tenantHeader(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string>)?.["X-Tenant"];
}

// --- API-key auth ----------------------------------------------------------

describe("API-key auth", () => {
  it("sends the key as a bearer token and no X-Tenant", async () => {
    const fetchImpl = mockFetch([{ body: { items: [], page: 1 } }]);
    const cms = createClient({ baseUrl: BASE, apiKey: "bcms_secret", fetch: fetchImpl });

    await cms.contents.list({ contentType: "post" });

    expect(fetchImpl.calls[0].url).toBe(`${BASE}/api/contents?contentType=post`);
    expect(authHeader(fetchImpl.calls[0].init)).toBe("Bearer bcms_secret");
    expect(tenantHeader(fetchImpl.calls[0].init)).toBeUndefined();
  });

  it("does not attempt a refresh on 401", async () => {
    const fetchImpl = mockFetch([{ status: 401, body: { message: "Invalid API key" } }]);
    const cms = createClient({ baseUrl: BASE, apiKey: "bcms_bad", fetch: fetchImpl });

    await expect(cms.contents.list()).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl.calls).toHaveLength(1); // one attempt, no refresh
  });
});

// --- JWT auth --------------------------------------------------------------

describe("JWT auth", () => {
  it("derives X-Tenant from the token claim", async () => {
    const token = jwt({ tenant: "acme", UserId: "1" });
    const fetchImpl = mockFetch([{ body: [] }]);
    const cms = createClient({ baseUrl: BASE, token, fetch: fetchImpl });

    await cms.contentTypes.list();

    expect(authHeader(fetchImpl.calls[0].init)).toBe(`Bearer ${token}`);
    expect(tenantHeader(fetchImpl.calls[0].init)).toBe("acme");
  });

  it("refreshes once on 401 and retries, sharing one refresh for concurrent calls", async () => {
    const oldToken = jwt({ tenant: "acme" });
    const newToken = jwt({ tenant: "acme" });
    // Two initial 401s, one refresh, then two OK retries.
    const fetchImpl = mockFetch([
      { status: 401, body: { message: "expired" } },
      { status: 401, body: { message: "expired" } },
      { status: 200, body: { token: newToken, refreshToken: "r2" } }, // refresh
      { body: { items: [] } },
      { body: [] },
    ]);
    const cms = createClient({ baseUrl: BASE, token: oldToken, refreshToken: "r1", fetch: fetchImpl });

    await Promise.all([cms.contents.list(), cms.contentTypes.list()]);

    const refreshCalls = fetchImpl.calls.filter((c) => c.url.endsWith("/api/auth/refresh"));
    expect(refreshCalls).toHaveLength(1); // single-flight: concurrent 401s share one refresh
    // The retried requests carry the new token.
    const retried = fetchImpl.calls.filter((c) => !c.url.endsWith("/api/auth/refresh"));
    expect(authHeader(retried[retried.length - 1].init)).toBe(`Bearer ${newToken}`);
  });

  it("login posts credentials with X-Tenant and stores the tokens", async () => {
    const token = jwt({ tenant: "acme" });
    const fetchImpl = mockFetch([
      { body: { token, expiry: "", refreshToken: "r", refreshTokenExpiry: "" } }, // login
      { body: [] }, // subsequent call uses the stored token
    ]);
    const cms = createClient({ baseUrl: BASE, fetch: fetchImpl });

    await cms.auth.login("user", "pass", "acme");
    expect(cms.auth.isAuthenticated).toBe(true);
    expect(fetchImpl.calls[0].url).toBe(`${BASE}/api/auth/login`);
    expect(tenantHeader(fetchImpl.calls[0].init)).toBe("acme");
    expect(JSON.parse(fetchImpl.calls[0].init.body as string)).toEqual({ username: "user", password: "pass" });

    await cms.contentTypes.list();
    expect(authHeader(fetchImpl.calls[1].init)).toBe(`Bearer ${token}`);
  });
});

// --- transport / errors ----------------------------------------------------

describe("transport", () => {
  it("throws a BarakoError carrying the status and server message", async () => {
    const fetchImpl = mockFetch([{ status: 400, body: { message: "Field 'Email' expects type 'email'" } }]);
    const cms = createClient({ baseUrl: BASE, apiKey: "bcms_x", fetch: fetchImpl });

    const err = await cms.contents.create({ contentType: "m", data: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(BarakoError);
    expect(err.status).toBe(400);
    expect(err.isValidation).toBe(true);
    expect(err.message).toContain("email");
  });

  it("returns undefined for a 204 (e.g. a status change with no body)", async () => {
    const fetchImpl = mockFetch([{ status: 204 }]);
    const cms = createClient({ baseUrl: BASE, apiKey: "bcms_x", fetch: fetchImpl });
    await expect(cms.contents.setStatus("id", 2)).resolves.toBeUndefined();
  });

  it("omits undefined query params", async () => {
    const fetchImpl = mockFetch([{ body: {} }]);
    const cms = createClient({ baseUrl: BASE, apiKey: "bcms_x", fetch: fetchImpl });
    await cms.contents.list({ contentType: "post", pageSize: 5 });
    expect(fetchImpl.calls[0].url).toBe(`${BASE}/api/contents?contentType=post&pageSize=5`);
  });
});

describe("tenantOfToken", () => {
  it("reads the tenant claim, or null when absent/invalid", () => {
    expect(tenantOfToken(jwt({ tenant: "acme" }))).toBe("acme");
    expect(tenantOfToken(jwt({ UserId: "1" }))).toBeNull();
    expect(tenantOfToken("not-a-jwt")).toBeNull();
    expect(tenantOfToken(undefined)).toBeNull();
  });
});

// --- public delivery (anonymous) -------------------------------------------

describe("public delivery", () => {
  it("lists published entries with no auth, and sends X-Tenant when configured", async () => {
    const fetchImpl = mockFetch([{ body: { items: [{ id: "1", contentType: "post", slug: "hello", data: {} }], page: 1 } }]);
    const cms = createClient({ baseUrl: BASE, tenant: "acme", fetch: fetchImpl });

    const page = await cms.public.list("post", { page: 1, pageSize: 10 });

    expect(page.items[0].slug).toBe("hello");
    expect(fetchImpl.calls[0].url).toBe(`${BASE}/api/public/post?page=1&pageSize=10`);
    expect(authHeader(fetchImpl.calls[0].init)).toBeUndefined();
    expect(tenantHeader(fetchImpl.calls[0].init)).toBe("acme");
  });

  it("gets an entry by slug", async () => {
    const fetchImpl = mockFetch([{ body: { id: "1", contentType: "post", slug: "hello", data: { Title: "Hi" } } }]);
    const cms = createClient({ baseUrl: BASE, fetch: fetchImpl });

    const post = await cms.public.bySlug("post", "hello");

    expect(post?.data.Title).toBe("Hi");
    expect(fetchImpl.calls[0].url).toBe(`${BASE}/api/public/post/hello`);
  });

  it("returns null (not an error) when a slug is not found", async () => {
    const fetchImpl = mockFetch([{ status: 404, text: "not found" }]);
    const cms = createClient({ baseUrl: BASE, fetch: fetchImpl });

    await expect(cms.public.bySlug("post", "nope")).resolves.toBeNull();
  });

  it("fetches a menu (a 'menu' content type) and returns null when missing", async () => {
    /* The API returns a PublicContent; the client maps data.Name/data.Items into a PublicMenu.
     * Item keys arrive PascalCase from the admin and are normalized to the typed shape. */
    const ok = mockFetch([
      {
        body: {
          id: "1",
          contentType: "menu",
          slug: "main",
          data: {
            Name: "Main",
            Items: [
              { Label: "Blog", Url: "/blog", OpenInNewTab: true },
              { Label: "Docs", Url: "/docs", Children: [{ Label: "Guide", Url: "/docs/guide" }] },
            ],
          },
        },
      },
    ]);
    const cms1 = createClient({ baseUrl: BASE, fetch: ok });
    const menu = await cms1.public.menu("main");
    expect(menu?.name).toBe("Main");
    expect(menu?.items[0].label).toBe("Blog");
    expect(menu?.items[0].openInNewTab).toBe(true);
    expect(menu?.items[1].children?.[0].label).toBe("Guide");
    expect(ok.calls[0].url).toBe(`${BASE}/api/public/menu/main`);

    const missing = mockFetch([{ status: 404 }]);
    const cms2 = createClient({ baseUrl: BASE, fetch: missing });
    await expect(cms2.public.menu("nope")).resolves.toBeNull();
  });

  it("builds a public file URL", () => {
    const cms = createClient({ baseUrl: BASE, fetch: mockFetch([]) });
    expect(cms.public.fileUrl("abc-123")).toBe(`${BASE}/api/public/files/abc-123`);
  });
});
