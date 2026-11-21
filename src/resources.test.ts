import { describe, expect, it } from "vitest";
import { BUILTIN_RESOURCES, createClient, type ResourceDefinition } from "./index";

const BASE = "https://cms.test/barakocms-api";

function mockFetch(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    const status = r.status ?? 200;
    const nullBody = status === 204 || r.body === undefined;
    return new Response(nullBody ? null : JSON.stringify(r.body), { status, headers: r.headers });
  }) as unknown as typeof fetch;
  return Object.assign(fn, { calls });
}

const ORDERS: ResourceDefinition = {
  name: "orders",
  list: { method: "GET", path: "/api/modules/orders" },
  get: { method: "GET", path: "/api/modules/orders/{id}" },
  create: { method: "POST", path: "/api/modules/orders", dryRun: true },
  update: { method: "PUT", path: "/api/modules/orders/{id}" },
  delete: { method: "DELETE", path: "/api/modules/orders/{id}" },
};

function client(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }> = [{ body: {} }], resources = [ORDERS]) {
  const fetchImpl = mockFetch(responses);
  return { cms: createClient({ baseUrl: BASE, apiKey: "bcms_k", fetch: fetchImpl, resources }), fetchImpl };
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

describe("the resource table", () => {
  it("holds contents and content-types, and contents has no delete", () => {
    const { cms } = client();
    expect(cms.resources.names()).toEqual(["contents", "content-types", "orders"]);
    expect(cms.resources.definition("contents")).toMatchObject({
      list: { method: "GET", path: "/api/contents" },
      get: { method: "GET", path: "/api/contents/{id}" },
      create: { method: "POST", path: "/api/contents", dryRun: true },
      update: { method: "PUT", path: "/api/contents/{id}", dryRun: true },
    });
    expect(cms.resources.definition("contents")).not.toHaveProperty("delete");
    expect(BUILTIN_RESOURCES.map((d) => d.name)).toEqual(["contents", "content-types"]);
  });

  it("looks a name up in a Map, so __proto__ and constructor are not resources", () => {
    const { cms } = client();
    expect(cms.resources.definition("__proto__")).toBeUndefined();
    expect(cms.resources.definition("constructor")).toBeUndefined();
    expect(cms.resources.definition("toString")).toBeUndefined();
  });

  it("keeps its own copy of a definition, so changing the original later changes nothing", () => {
    const mine: ResourceDefinition = { name: "mine", list: { method: "GET", path: "/api/mine" } };
    const { cms } = client([{ body: {} }], [mine]);
    mine.list!.path = "/api/elsewhere";
    expect(cms.resources.definition("mine")!.list!.path).toBe("/api/mine");
    expect(Object.isFrozen(cms.resources.definition("mine"))).toBe(true);
  });
});

describe("resource definition checks", () => {
  const route = (over: Record<string, unknown>) => ({ method: "GET", path: "/api/x", ...over });
  const cases: Array<[string, unknown, string]> = [
    ["a name with a capital", { name: "Orders" }, `"name" must match`],
    ["a name with a slash", { name: "a/b" }, `"name" must match`],
    ["a name that starts with an underscore", { name: "__proto__" }, `"name" must match`],
    ["a name over 64 characters", { name: "a".repeat(65) }, `"name" must match`],
    ["an unknown key on the definition", { name: "x", bogus: 1 }, `"x": unknown key "bogus"`],
    ["an unknown key on a route", { name: "x", list: route({ extra: 1 }) }, `"x" list: unknown key "extra"`],
    ["a method that is not one of the five", { name: "x", list: route({ method: "TRACE" }) }, `"x" list: "method" must be one of`],
    ["list with a method other than GET", { name: "x", list: route({ method: "DELETE" }) }, `"method" must be GET for list`],
    ["delete with a method other than DELETE", { name: "x", delete: route({ method: "GET", path: "/api/x/{id}" }) }, `"method" must be DELETE for delete`],
    ["create with a method other than POST", { name: "x", create: route({ method: "PUT" }) }, `"method" must be POST for create`],
    ["a path that does not start with /api/", { name: "x", list: route({ path: "/x" }) }, `"path" must start with /api/`],
    ["a path with a query string", { name: "x", list: route({ path: "/api/a?b" }) }, `"path" must not contain "?"`],
    ["a path with a fragment", { name: "x", list: route({ path: "/api/a#b" }) }, `"path" must not contain "#"`],
    ["a path with ..", { name: "x", list: route({ path: "/api/../x" }) }, `"path" must not contain ".."`],
    ["a path with //", { name: "x", list: route({ path: "/api//x" }) }, `"path" must not contain "//"`],
    ["a path with a backslash", { name: "x", list: route({ path: "/api/a\\b" }) }, `"path" must not contain`],
    ["a path with a percent sign", { name: "x", list: route({ path: "/api/a%2fb" }) }, `"path" must not contain "%"`],
    ["a path with whitespace", { name: "x", list: route({ path: "/api/a b" }) }, `"path" must not contain whitespace`],
    ["a path with a dot segment", { name: "x", list: route({ path: "/api/./x" }) }, `empty or "." segment`],
    ["a placeholder other than {id}", { name: "x", get: route({ path: "/api/{other}" }) }, `no placeholder but {id}`],
    ["an {id} that is only part of a segment", { name: "x", get: route({ path: "/api/a{id}" }) }, `{id} must be a whole segment`],
    ["a get route without {id}", { name: "x", get: route({}) }, `"path" must hold {id}`],
    ["an update route without {id}", { name: "x", update: route({ method: "PUT" }) }, `"path" must hold {id}`],
    ["a list route with {id}", { name: "x", list: route({ path: "/api/x/{id}" }) }, `"path" must not hold {id}`],
    ["a create route with {id}", { name: "x", create: route({ method: "POST", path: "/api/x/{id}" }) }, `"path" must not hold {id}`],
    ["dryRun on a delete route", { name: "x", delete: route({ method: "DELETE", path: "/api/x/{id}", dryRun: true }) }, `"dryRun" is allowed on create and update only`],
    ["dryRun that is not a boolean", { name: "x", create: route({ method: "POST", dryRun: "yes" }) }, `"dryRun" must be true or false`],
    ["a name that is built in", { name: "contents" }, `"contents": "name" is already taken`],
  ];

  it("createClient refuses each bad definition naming what failed, before any request", () => {
    for (const [label, def, expected] of cases) {
      const fetchImpl = mockFetch([{ body: {} }]);
      let message = "";
      try {
        createClient({ baseUrl: BASE, apiKey: "k", fetch: fetchImpl, resources: [def as ResourceDefinition] });
      } catch (err) {
        expect(err, label).toBeInstanceOf(TypeError);
        message = (err as Error).message;
      }
      expect(message, label).toContain(expected);
      expect(fetchImpl.calls, label).toHaveLength(0);
    }
  });

  it("createClient refuses two definitions with the same name", () => {
    expect(() => client([{ body: {} }], [ORDERS, ORDERS])).toThrow(`"orders": "name" is already taken`);
  });

  it("createClient refuses a path that holds {id} twice, a trailing slash and a bare /api/", () => {
    const bad = (verb: string, path: string, method = "GET") => () =>
      client([{ body: {} }], [{ name: "x", [verb]: { method, path } } as unknown as ResourceDefinition]);
    expect(bad("get", "/api/a/{id}/b/{id}")).toThrow(`"x" get: "path" must hold {id} exactly once.`);
    expect(bad("delete", "/api/a/{id}/{id}", "DELETE")).toThrow("exactly once");
    expect(bad("get", "/api/a/{id}/")).toThrow("empty");
    expect(bad("list", "/api/")).toThrow("empty");
    expect(bad("list", "/api/a/")).toThrow("empty");
  });

  it("createClient accepts merge data on update only, and the contents update has it", () => {
    const def = (verb: string, merge: unknown, method: string, path: string) =>
      client([{ body: {} }], [{ name: "x", [verb]: { method, path, merge } } as unknown as ResourceDefinition]);
    expect(def("update", "data", "PUT", "/api/x/{id}").cms.resources.definition("x")?.update).toEqual({ method: "PUT", path: "/api/x/{id}", merge: "data" });
    expect(() => def("update", "other", "PUT", "/api/x/{id}")).toThrow(`"x" update: "merge" must be "data".`);
    expect(() => def("create", "data", "POST", "/api/x")).toThrow(`"x" create: "merge" is allowed on update only.`);
    expect(() => def("update", true, "PUT", "/api/x/{id}")).toThrow(`"merge" must be "data"`);
    expect(BUILTIN_RESOURCES[0]!.update?.merge).toBe("data");
  });

  it("createClient names an unknown key only when it is short and plain", () => {
    const long = "k".repeat(1000);
    const cases: Array<[string, ResourceDefinition]> = [
      ["escape on a definition", { name: "x", ["\u001b[31mred"]: 1 } as unknown as ResourceDefinition],
      ["long on a definition", { name: "x", [long]: 1 } as unknown as ResourceDefinition],
      ["escape on a route", { name: "x", list: { method: "GET", path: "/api/x", ["\u001b[31mred"]: 1 } } as unknown as ResourceDefinition],
      ["long on a route", { name: "x", list: { method: "GET", path: "/api/x", [long]: 1 } } as unknown as ResourceDefinition],
      ["a proto key on a definition", JSON.parse('{"name":"x","__proto__":{}}') as ResourceDefinition],
      ["a proto key on a route", JSON.parse('{"name":"x","list":{"method":"GET","path":"/api/x","__proto__":{}}}') as ResourceDefinition],
    ];
    for (const [label, def] of cases) {
      let message = "";
      try {
        client([{ body: {} }], [def]);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, label).toContain("an unknown key.");
      expect(message, label).not.toContain("\u001b");
      expect(message.length, label).toBeLessThan(200);
    }
  });

  it("createClient refuses a definition that is not an object", () => {
    expect(() => createClient({ baseUrl: BASE, apiKey: "k", resources: [null as unknown as ResourceDefinition] })).toThrow("a definition must be an object");
  });
});

describe("resources.call", () => {
  it("sends each verb of a loaded resource with its method and path", async () => {
    const { cms, fetchImpl } = client([{ body: {} }]);
    await cms.resources.call("orders", "list");
    await cms.resources.call("orders", "get", { id: "o1" });
    await cms.resources.call("orders", "create", { body: { a: 1 } });
    await cms.resources.call("orders", "update", { id: "o1", body: { a: 2 } });
    await cms.resources.call("orders", "delete", { id: "o1" });
    expect(fetchImpl.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `GET ${BASE}/api/modules/orders`,
      `GET ${BASE}/api/modules/orders/o1`,
      `POST ${BASE}/api/modules/orders`,
      `PUT ${BASE}/api/modules/orders/o1`,
      `DELETE ${BASE}/api/modules/orders/o1`,
    ]);
    expect(JSON.parse(fetchImpl.calls[2]!.init.body as string)).toEqual({ a: 1 });
    expect(JSON.parse(fetchImpl.calls[3]!.init.body as string)).toEqual({ a: 2 });
  });

  it("goes through the client's transport, so the key is sent", async () => {
    const { cms, fetchImpl } = client();
    await cms.resources.call("orders", "list");
    expect(headersOf(fetchImpl.calls[0]!.init)["Authorization"]).toBe("Bearer bcms_k");
  });

  it("calls the same route as contents.get for the built in contents resource", async () => {
    const { cms, fetchImpl } = client();
    await cms.resources.call("contents", "get", { id: "c1" });
    await cms.contents.get("c1");
    expect(fetchImpl.calls[0]!.url).toBe(fetchImpl.calls[1]!.url);
  });

  it("encodes an id as one path segment", async () => {
    const { cms, fetchImpl } = client();
    for (const id of ["a/b", "../x", "?q=1", "%2f", "x#y", "__proto__", "constructor"]) {
      await cms.resources.call("orders", "get", { id });
      expect(fetchImpl.calls.at(-1)!.url, id).toBe(`${BASE}/api/modules/orders/${encodeURIComponent(id)}`);
    }
  });

  it("refuses an id of .. or an empty id before any request", async () => {
    const { cms, fetchImpl } = client();
    await expect(cms.resources.call("orders", "get", { id: ".." })).rejects.toThrow("Invalid path segment");
    await expect(cms.resources.call("orders", "delete", { id: "" })).rejects.toThrow("Invalid path segment");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("refuses a route that needs an id when none is given, and an id on a route with none", async () => {
    const { cms, fetchImpl } = client();
    await expect(cms.resources.call("orders", "get")).rejects.toThrow("GET /api/modules/orders/{id} needs an id");
    await expect(cms.resources.call("orders", "list", { id: "o1" })).rejects.toThrow("GET /api/modules/orders takes no id");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("refuses a body on a verb that takes none", async () => {
    const { cms, fetchImpl } = client();
    await expect(cms.resources.call("orders", "delete", { id: "o1", body: { a: 1 } })).rejects.toThrow(
      "DELETE /api/modules/orders/{id} takes no body",
    );
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("refuses an unknown resource and lists the valid names, for prototype keys too", async () => {
    const { cms, fetchImpl } = client();
    for (const name of ["nope", "__proto__", "constructor", "../x", "a/b"]) {
      await expect(cms.resources.call(name, "list"), name).rejects.toThrow("Valid resources: contents, content-types, orders");
    }
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("refuses a verb the resource lacks and names the verbs it has", async () => {
    const { cms, fetchImpl } = client();
    await expect(cms.resources.call("contents", "delete", { id: "c1" })).rejects.toThrow(
      "contents has no delete. It has: list, get, create, update.",
    );
    await expect(cms.resources.call("contents", "__proto__" as never)).rejects.toThrow("contents has no __proto__");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("sends dryRun in the body on a route marked as taking one", async () => {
    const { cms, fetchImpl } = client();
    await cms.resources.call("orders", "create", { body: { a: 1 }, dryRun: true });
    expect(JSON.parse(fetchImpl.calls[0]!.init.body as string)).toEqual({ a: 1, dryRun: true });
    await cms.resources.call("orders", "create", { body: { a: 1 } });
    expect(JSON.parse(fetchImpl.calls[1]!.init.body as string)).toEqual({ a: 1 });
  });

  it("sends exactly { dryRun: true } for a dry run with no body, and no body without one", async () => {
    const { cms, fetchImpl } = client();
    await cms.resources.call("orders", "create", { dryRun: true });
    expect(JSON.parse(fetchImpl.calls[0]!.init.body as string)).toEqual({ dryRun: true });
    await cms.resources.call("orders", "create");
    expect(fetchImpl.calls[1]!.init.body).toBeUndefined();
  });

  it("a generic get and list with no dry run time out on the read limit", async () => {
    const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const cms = createClient({ baseUrl: BASE, apiKey: "bcms_k", fetch: hang, resources: [ORDERS], timeouts: { readMs: 25 } });
    await expect(cms.resources.call("orders", "get", { id: "o1" })).rejects.toMatchObject({ code: "timeout" });
    await expect(cms.resources.call("orders", "list")).rejects.toMatchObject({ code: "timeout" });
  });

  it("refuses dryRun on a route not marked, naming METHOD path, before any request", async () => {
    const { cms, fetchImpl } = client();
    await expect(cms.resources.call("orders", "update", { id: "o1", body: {}, dryRun: true })).rejects.toThrow(
      "PUT /api/modules/orders/{id} does not take a dry run",
    );
    await expect(cms.resources.call("orders", "delete", { id: "o1", dryRun: true })).rejects.toThrow(
      "DELETE /api/modules/orders/{id} does not take a dry run",
    );
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("encodes query values the way the transport does", async () => {
    const { cms, fetchImpl } = client();
    await cms.resources.call("orders", "list", { query: { q: "a b&c", page: 2, skip: undefined } });
    expect(fetchImpl.calls[0]!.url).toBe(`${BASE}/api/modules/orders?q=a%20b%26c&page=2`);
  });

  it("sends ifMatch as If-Match", async () => {
    const { cms, fetchImpl } = client();
    await cms.resources.call("orders", "update", { id: "o1", body: {}, ifMatch: '"e1"' });
    expect(headersOf(fetchImpl.calls[0]!.init)["If-Match"]).toBe('"e1"');
  });

  it("adds the ETag to a get or update answer, and not to a list", async () => {
    const { cms } = client([{ body: { id: "o1" }, headers: { ETag: '"e9"' } }]);
    expect(await cms.resources.call("orders", "get", { id: "o1" })).toEqual({ id: "o1", etag: '"e9"' });
    expect(await cms.resources.call("orders", "update", { id: "o1", body: {} })).toEqual({ id: "o1", etag: '"e9"' });
    expect(await cms.resources.call("orders", "list")).toEqual({ id: "o1" });
  });

  it("does not add an ETag to a dry run answer", async () => {
    const marked: ResourceDefinition = { ...ORDERS, name: "ledgers", update: { method: "PUT", path: "/api/modules/ledgers/{id}", dryRun: true } };
    const { cms } = client([{ body: { dryRun: true }, headers: { ETag: '"e9"' } }, { body: { id: "o1" }, headers: { ETag: '"e9"' } }], [marked]);
    expect(await cms.resources.call("ledgers", "update", { id: "o1", body: {}, dryRun: true })).toEqual({ dryRun: true });
    expect(await cms.resources.call("ledgers", "update", { id: "o1", body: {} })).toEqual({ id: "o1", etag: '"e9"' });
  });

  it("returns undefined for a 204", async () => {
    const { cms } = client([{ status: 204 }]);
    expect(await cms.resources.call("orders", "delete", { id: "o1" })).toBeUndefined();
  });
});
