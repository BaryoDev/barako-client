import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BarakoClient } from "@baryodev/barako-client";
import { run } from "../main";
import { toCliError } from "../output";
import { commands } from "../registry";
import { loadResourcesFile } from "../resources-file";

afterEach(() => vi.unstubAllGlobals());

const ENV = { BARAKO_URL: "https://cms.test", BARAKO_API_KEY: "bcms_testkey" };

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}
interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Runs the CLI end to end against a fake fetch that records every request. */
async function cli(
  argv: string[],
  opts: { files?: Record<string, string>; env?: Record<string, string>; reply?: (call: Call, n: number) => Reply } = {},
) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call: Call = {
      method: init.method ?? "GET",
      url,
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
      headers: init.headers as Record<string, string>,
    };
    calls.push(call);
    const r = opts.reply?.(call, calls.length - 1) ?? { body: {} };
    const status = r.status ?? 200;
    return new Response(status === 204 || r.body === undefined ? null : JSON.stringify(r.body), { status, headers: r.headers });
  });
  const files = opts.files ?? {};
  const out: { stream: string; text: string }[] = [];
  const code = await run(argv, { ...ENV, ...opts.env }, {
    readFile: (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p]!;
    },
    write: (stream, text) => out.push({ stream, text }),
  });
  const body = JSON.parse(out[0]!.text) as { ok: boolean; result?: any; error?: { code: string; message: string; status: number | null } };
  return { code, calls, body, summary: calls.map((c) => `${c.method} ${c.url}`) };
}

const INVOICES = {
  name: "invoices",
  list: { method: "GET", path: "/api/modules/invoices" },
  get: { method: "GET", path: "/api/modules/invoices/{id}" },
  create: { method: "POST", path: "/api/modules/invoices", dryRun: true },
  update: { method: "PUT", path: "/api/modules/invoices/{id}" },
  delete: { method: "DELETE", path: "/api/modules/invoices/{id}" },
};
const FILES = { "res.json": JSON.stringify({ resources: [INVOICES] }) };
const WITH_FILE = ["--resources", "res.json"];
const BASE = "https://cms.test";

describe("a resource loaded from a definitions file", () => {
  it("is driven through get, list, create, update and delete with no command written for it", async () => {
    const reply = (c: Call): Reply => {
      if (c.method === "GET" && c.url.endsWith("/i1")) return { body: { id: "i1", version: 3, total: 5 } };
      if (c.method === "GET") return { body: { items: [{ id: "i1" }], hasNextPage: false } };
      if (c.method === "POST") return { body: { id: "i2" } };
      if (c.method === "PUT") return { body: { id: "i1", version: 4 } };
      return { status: 204 };
    };
    const opts = { files: FILES, reply };

    const get = await cli(["get", "invoices", "i1", ...WITH_FILE], opts);
    expect(get.summary).toEqual([`GET ${BASE}/api/modules/invoices/i1`]);
    expect(get.body.result).toEqual({ id: "i1", version: 3, total: 5 });

    const list = await cli(["list", "invoices", ...WITH_FILE], opts);
    expect(list.summary).toEqual([`GET ${BASE}/api/modules/invoices`]);
    expect(list.body.result.items).toEqual([{ id: "i1" }]);

    const create = await cli(["create", "invoices", "--set", "total:=9", ...WITH_FILE], opts);
    expect(create.summary).toEqual([`POST ${BASE}/api/modules/invoices`]);
    expect(create.calls[0]!.body).toEqual({ total: 9 });

    const update = await cli(["update", "invoices", "i1", "--set", "total:=7", ...WITH_FILE], opts);
    expect(update.summary).toEqual([`GET ${BASE}/api/modules/invoices/i1`, `PUT ${BASE}/api/modules/invoices/i1`]);
    expect(update.calls[1]!.body).toEqual({ id: "i1", total: 7, version: 3 });

    const del = await cli(["delete", "invoices", "i1", "--confirm", "i1", ...WITH_FILE], opts);
    expect(del.summary).toEqual([`DELETE ${BASE}/api/modules/invoices/i1`]);
    expect(del.body.result).toEqual({ deleted: "i1", resource: "invoices" });
  });

  it("is read from BARAKO_RESOURCES, and --resources wins over it", async () => {
    const other = { resources: [{ ...INVOICES, name: "other", list: { method: "GET", path: "/api/modules/other" } }] };
    const files = { ...FILES, "other.json": JSON.stringify(other) };
    const fromEnv = await cli(["list", "invoices"], { files, env: { BARAKO_RESOURCES: "res.json" } });
    expect(fromEnv.summary).toEqual([`GET ${BASE}/api/modules/invoices`]);
    const flagWins = await cli(["list", "other", "--resources", "other.json"], { files, env: { BARAKO_RESOURCES: "res.json" } });
    expect(flagWins.summary).toEqual([`GET ${BASE}/api/modules/other`]);
    const gone = await cli(["list", "invoices", "--resources", "other.json"], { files, env: { BARAKO_RESOURCES: "res.json" } });
    expect(gone.code).toBe(1);
    expect(gone.calls).toHaveLength(0);
  });

  it("is refused with a usage error when the resources file cannot be read", async () => {
    const r = await cli(["list", "invoices", "--resources", "missing.json"]);
    expect(r.code).toBe(1);
    expect(r.body.error!.message).toContain("could not be read");
    expect(r.calls).toHaveLength(0);
  });
});

describe("generic get", () => {
  it("drops the etag from the row, as content get does", async () => {
    const r = await cli(["get", "invoices", "i1", ...WITH_FILE], {
      files: FILES,
      reply: () => ({ body: { id: "i1" }, headers: { ETag: '"e1"' } }),
    });
    expect(r.body.result).toEqual({ id: "i1" });
  });

  it("reads a built in resource", async () => {
    const r = await cli(["get", "contents", "c1"]);
    expect(r.summary).toEqual([`GET ${BASE}/api/contents/c1`]);
  });

  it("names the route, not content:destructive, on a 403", async () => {
    const r = await cli(["get", "invoices", "i1", ...WITH_FILE], { files: FILES, reply: () => ({ status: 403, body: { message: "no" } }) });
    expect(r.code).toBe(5);
    expect(r.body.error).toMatchObject({ code: "forbidden", status: 403 });
    expect(r.body.error!.message).toContain("GET /api/modules/invoices/{id}");
    expect(r.body.error!.message).not.toContain("content:destructive");
  });
});

describe("generic list", () => {
  it("sends --query pairs and --limit as query parameters", async () => {
    const r = await cli(["list", "invoices", "--query", "status=open", "--query", "q=a b", "--limit", "5", ...WITH_FILE], { files: FILES });
    expect(r.summary).toEqual([`GET ${BASE}/api/modules/invoices?status=open&q=a%20b&pageSize=5`]);
  });

  it("refuses a --query that is not name=value or is given twice, with no request", async () => {
    const bad = await cli(["list", "invoices", "--query", "novalue", ...WITH_FILE], { files: FILES });
    expect(bad.code).toBe(1);
    const twice = await cli(["list", "invoices", "--query", "a=1", "--query", "a=2", ...WITH_FILE], { files: FILES });
    expect(twice.code).toBe(1);
    expect(twice.body.error!.message).toContain("more than once");
    expect(bad.calls.length + twice.calls.length).toBe(0);
  });

  it("with --all follows every page", async () => {
    const reply = (c: Call): Reply => {
      const page = Number(new URL(c.url).searchParams.get("page"));
      return { body: { items: [{ id: `a${page}` }, { id: `b${page}` }], hasNextPage: page < 3 } };
    };
    const r = await cli(["list", "invoices", "--all", "--query", "status=open", ...WITH_FILE], { files: FILES, reply });
    expect(r.summary).toEqual([1, 2, 3].map((p) => `GET ${BASE}/api/modules/invoices?status=open&page=${p}&pageSize=100`));
    expect(r.body.result.items).toHaveLength(6);
    expect(r.body.result.truncated).toBe(false);
  });

  it("with --all stops at 5000 rows, the same cap as content list, and says it was cut", async () => {
    const reply = (c: Call): Reply => {
      const page = Number(new URL(c.url).searchParams.get("page"));
      return { body: { items: Array.from({ length: 100 }, (_, i) => ({ id: `${page}-${i}` })), hasNextPage: true } };
    };
    const r = await cli(["list", "invoices", "--all", ...WITH_FILE], { files: FILES, reply });
    expect(r.calls).toHaveLength(50);
    expect(r.body.result.items).toHaveLength(5000);
    expect(r.body.result.truncated).toBe(true);
  });

  it("with --all marks an empty page that promises more as cut", async () => {
    const reply = (c: Call): Reply =>
      new URL(c.url).searchParams.get("page") === "1" ? { body: { items: [{ id: "a" }], hasNextPage: true } } : { body: { items: [], hasNextPage: true } };
    const r = await cli(["list", "invoices", "--all", ...WITH_FILE], { files: FILES, reply });
    expect(r.calls).toHaveLength(2);
    expect(r.body.result).toEqual({ items: [{ id: "a" }], truncated: true });
  });

  it("with --all on a response that is not paged is a usage error, not a guess", async () => {
    for (const body of [[{ id: "a" }], { rows: [] }, "text"]) {
      const r = await cli(["list", "invoices", "--all", ...WITH_FILE], { files: FILES, reply: () => ({ body }) });
      expect(r.code, JSON.stringify(body)).toBe(1);
      expect(r.body.error!.message).toContain("--all needs a paged response");
      expect(r.calls).toHaveLength(1);
    }
  });

  it("with --all refuses --query page or pageSize before any request", async () => {
    const r = await cli(["list", "invoices", "--all", "--query", "page=2", ...WITH_FILE], { files: FILES });
    expect(r.code).toBe(1);
    expect(r.body.error!.message).toContain("--all sets page itself");
    expect(r.calls).toHaveLength(0);
  });
});

describe("generic create", () => {
  it("sends dryRun on a create route marked as taking one", async () => {
    const r = await cli(["create", "invoices", "--set", "total:=9", "--dry-run", ...WITH_FILE], { files: FILES });
    expect(r.calls[0]!.body).toEqual({ total: 9, dryRun: true });
  });

  it("sends no dryRun field without --dry-run", async () => {
    const r = await cli(["create", "invoices", "--set", "total:=9", ...WITH_FILE], { files: FILES });
    expect(r.calls[0]!.body).not.toHaveProperty("dryRun");
  });

  it("sends dryRun to the built in contents create, which is marked", async () => {
    const files = { "body.json": JSON.stringify({ contentType: "post", data: { Title: "x" } }) };
    const r = await cli(["create", "contents", "--file", "body.json", "--dry-run"], { files });
    expect(r.summary).toEqual([`POST ${BASE}/api/contents`]);
    expect(r.calls[0]!.body).toEqual({ contentType: "post", data: { Title: "x" }, dryRun: true });
  });

  it("refuses --dry-run on a create route that is not marked, naming POST and the path", async () => {
    const r = await cli(["create", "content-types", "--set", "name=x", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.body.error!.message).toContain("POST /api/content-types does not take a dry run");
    expect(r.calls).toHaveLength(0);
  });

  it("refuses a create with no fields, with no request", async () => {
    const r = await cli(["create", "invoices", ...WITH_FILE], { files: FILES });
    expect(r.code).toBe(1);
    expect(r.body.error!.message).toContain("Nothing to send");
    expect(r.calls).toHaveLength(0);
  });
});

describe("generic update", () => {
  it("refuses --dry-run on an update route not marked, naming PUT and the path, and sends nothing", async () => {
    const r = await cli(["update", "invoices", "i1", "--set", "total:=7", "--dry-run", ...WITH_FILE], { files: FILES });
    expect(r.code).toBe(1);
    expect(r.body.error!.message).toContain("PUT /api/modules/invoices/{id} does not take a dry run");
    expect(r.calls).toHaveLength(0);
  });

  it("sends the version it read in the body", async () => {
    const r = await cli(["update", "invoices", "i1", "--set", "total:=7", ...WITH_FILE], {
      files: FILES,
      reply: (c) => (c.method === "GET" ? { body: { id: "i1", version: 5, total: 1 } } : { body: { id: "i1" } }),
    });
    expect(r.summary[0]).toBe(`GET ${BASE}/api/modules/invoices/i1`);
    expect(r.calls[1]!.body).toEqual({ id: "i1", total: 7, version: 5 });
    expect(r.calls[1]!.headers).not.toHaveProperty("If-Match");
  });

  it("sends the ETag it read as If-Match", async () => {
    const r = await cli(["update", "invoices", "i1", "--set", "total:=7", ...WITH_FILE], {
      files: FILES,
      reply: (c) => (c.method === "GET" ? { body: { id: "i1", version: 5 }, headers: { ETag: '"e5"' } } : { body: { id: "i1" } }),
    });
    expect(r.calls[1]!.headers["If-Match"]).toBe('"e5"');
    expect(r.calls[1]!.body).toMatchObject({ version: 5 });
  });

  it("sends version 0 with If-Match when the row has an ETag and no version", async () => {
    const r = await cli(["update", "invoices", "i1", "--set", "total:=7", ...WITH_FILE], {
      files: FILES,
      reply: (c) => (c.method === "GET" ? { body: { id: "i1" }, headers: { ETag: '"e0"' } } : { body: { id: "i1" } }),
    });
    expect(r.calls[1]!.headers["If-Match"]).toBe('"e0"');
    expect(r.calls[1]!.body).toMatchObject({ version: 0 });
  });

  it("sends nothing when the row has neither a version nor an ETag", async () => {
    const r = await cli(["update", "invoices", "i1", "--set", "total:=7", ...WITH_FILE], {
      files: FILES,
      reply: () => ({ body: { id: "i1" } }),
    });
    expect(r.code).toBe(3);
    expect(r.body.error!.code).toBe("version_required");
    expect(r.summary).toEqual([`GET ${BASE}/api/modules/invoices/i1`]);
  });

  it("stops with a conflict when --expect-version differs from the row", async () => {
    const r = await cli(["update", "invoices", "i1", "--set", "total:=7", "--expect-version", "2", ...WITH_FILE], {
      files: FILES,
      reply: () => ({ body: { id: "i1", version: 5 } }),
    });
    expect(r.body.error!.code).toBe("conflict");
    expect(r.calls).toHaveLength(1);
  });

  it("merges into the data of a row that keeps its fields under data, like content update", async () => {
    const r = await cli(["update", "contents", "c1", "--set", "Title=New"], {
      reply: (c) => (c.method === "GET" ? { body: { id: "c1", version: 2, data: { Title: "Old", Body: "b" } } } : { body: { id: "c1" } }),
    });
    expect(r.summary).toEqual([`GET ${BASE}/api/contents/c1`, `PUT ${BASE}/api/contents/c1`]);
    expect(r.calls[1]!.body).toEqual({ id: "c1", data: { Title: "New", Body: "b" }, version: 2 });
  });

  it("sends dryRun on the built in contents update, which is marked", async () => {
    const r = await cli(["update", "contents", "c1", "--set", "Title=New", "--dry-run"], {
      reply: (c) => (c.method === "GET" ? { body: { id: "c1", version: 2, data: {} } } : { body: { dryRun: true } }),
    });
    expect(r.calls[1]!.body).toMatchObject({ dryRun: true });
  });

  it("refuses to update a resource that has no get, since it cannot read the row", async () => {
    const def = { name: "notes", update: { method: "PUT", path: "/api/modules/notes/{id}" } };
    const r = await cli(["update", "notes", "n1", "--set", "a=b", "--resources", "n.json"], {
      files: { "n.json": JSON.stringify({ resources: [def] }) },
    });
    expect(r.code).toBe(1);
    expect(r.body.error!.message).toContain(`Resource "notes" has no get`);
    expect(r.calls).toHaveLength(0);
  });
});

describe("generic delete", () => {
  it("without --confirm makes no request, and names the resource", async () => {
    const r = await cli(["delete", "invoices", "i1", ...WITH_FILE], { files: FILES });
    expect(r.code).toBe(1);
    expect(r.body.error!.message).toContain("invoices id");
    expect(r.body.error!.message).not.toContain("entry");
    expect(r.calls).toHaveLength(0);
  });

  it("with a --confirm that differs from the id makes no request and echoes neither", async () => {
    const r = await cli(["delete", "invoices", "inv-secret", "--confirm", "inv-other", ...WITH_FILE], { files: FILES });
    expect(r.code).toBe(1);
    expect(r.body.error!.message).toContain("does not match the invoices id");
    expect(r.body.error!.message).not.toContain("inv-secret");
    expect(r.body.error!.message).not.toContain("inv-other");
    expect(r.calls).toHaveLength(0);
  });

  it("on contents, which has no delete route, is refused naming the verbs it has", async () => {
    for (const argv of [["delete", "contents", "c1"], ["delete", "contents", "c1", "--confirm", "c1"]]) {
      const r = await cli(argv);
      expect(r.code).toBe(1);
      expect(r.body.error!.message).toBe(`Resource "contents" has no delete. It has: list, get, create, update.`);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("names the route on a 403", async () => {
    const r = await cli(["delete", "invoices", "i1", "--confirm", "i1", ...WITH_FILE], {
      files: FILES,
      reply: () => ({ status: 403, body: {} }),
    });
    expect(r.body.error).toMatchObject({ code: "forbidden", status: 403 });
    expect(r.body.error!.message).toContain("DELETE /api/modules/invoices/{id}");
  });
});

describe("resource names and ids from the command line", () => {
  const NAMES = ["../x", "a/b", "?q=1", "%2f", "__proto__", "constructor", "nope"];

  it("refuse a resource name that is not in the table, on every verb, before any request", async () => {
    for (const name of NAMES) {
      const argvs = [
        ["get", name, "i1"],
        ["list", name],
        ["create", name, "--set", "a=b"],
        ["update", name, "i1", "--set", "a=b"],
        ["delete", name, "i1", "--confirm", "i1"],
      ];
      for (const argv of argvs) {
        const r = await cli([...argv, ...WITH_FILE], { files: FILES });
        const label = argv.join(" ");
        expect(r.code, label).toBe(1);
        expect(r.body.error!.message, label).toContain("Unknown resource. Valid resources: contents, content-types, invoices.");
        expect(r.calls, label).toHaveLength(0);
      }
    }
  });

  it("stay one path segment when used as an id, and never leave the template", async () => {
    const ids = ["../x", "a/b", "?q=1", "%2f", "__proto__", "constructor", "x#y"];
    for (const id of ids) {
      const get = await cli(["get", "invoices", id, ...WITH_FILE], { files: FILES });
      expect(get.summary, id).toEqual([`GET ${BASE}/api/modules/invoices/${encodeURIComponent(id)}`]);
      const del = await cli(["delete", "invoices", id, "--confirm", id, ...WITH_FILE], { files: FILES });
      expect(del.summary, id).toEqual([`DELETE ${BASE}/api/modules/invoices/${encodeURIComponent(id)}`]);
    }
  });

  it("refuse an id of .. as a usage error with no request", async () => {
    const r = await cli(["get", "invoices", "..", ...WITH_FILE], { files: FILES });
    expect(r.code).toBe(1);
    expect(r.body.error!.message).toContain("Invalid path segment");
    expect(r.calls).toHaveLength(0);
  });
});

describe("a verb the resource lacks", () => {
  it("is a usage error naming the resource and the verbs it has, with no request", async () => {
    const r = await cli(["update", "content-types", "t1", "--set", "a=b"]);
    expect(r.code).toBe(1);
    expect(r.body.error!.message).toBe(`Resource "content-types" has no update. It has: list, get, create.`);
    expect(r.calls).toHaveLength(0);
  });
});

describe("a definitions file that is refused", () => {
  const withDef = (def: unknown) => ({ "bad.json": JSON.stringify({ resources: [def] }) });
  const route = (over: Record<string, unknown>) => ({ method: "GET", path: "/api/x", ...over });
  const cases: Array<[string, Record<string, string>, string[]]> = [
    ["a path that does not start with /api/", withDef({ name: "x", list: route({ path: "/x" }) }), [`"x" list`, `"path" must start with /api/`]],
    ["a path with a query string", withDef({ name: "x", list: route({ path: "/api/a?b" }) }), [`"x" list`, `"path" must not contain "?"`]],
    ["a path with ..", withDef({ name: "x", list: route({ path: "/api/../x" }) }), [`"x" list`, `"path" must not contain ".."`]],
    ["a placeholder other than {id}", withDef({ name: "x", get: route({ path: "/api/{other}" }) }), [`"x" get`, `no placeholder but {id}`]],
    ["an unknown key", withDef({ name: "x", bogus: 1 }), [`"x"`, `unknown key "bogus"`]],
    ["the name of a built in resource", withDef({ name: "contents", list: route({}) }), [`"contents"`, `already taken`]],
    ["a delete route that takes dryRun", withDef({ name: "x", delete: route({ method: "DELETE", path: "/api/x/{id}", dryRun: true }) }), [`"x" delete`, `"dryRun" is allowed on create and update only`]],
    [
      "more than 200 entries",
      { "bad.json": JSON.stringify({ resources: Array.from({ length: 201 }, (_, i) => ({ name: `r${i}`, list: route({ path: `/api/r${i}` }) })) }) },
      ["more than 200 entries"],
    ],
    ["a file over 256 KB", { "bad.json": JSON.stringify({ resources: [] }) + " ".repeat(256 * 1024) }, ["over 256 KB"]],
    ["text that is not JSON", { "bad.json": "{ not json" }, ["not valid JSON"]],
    ["a top level that is not an object with resources", { "bad.json": "[]" }, [`must hold { "resources"`]],
    ["a top level key besides resources", { "bad.json": JSON.stringify({ resources: [], extra: 1 }) }, [`only the key "resources"`]],
    ["resources that is not an array", { "bad.json": JSON.stringify({ resources: {} }) }, [`"resources" must be an array`]],
  ];

  it("names what failed, and makes no request", async () => {
    for (const [label, files, expected] of cases) {
      const r = await cli(["get", "contents", "c1", "--resources", "bad.json"], { files });
      expect(r.code, label).toBe(1);
      for (const part of expected) expect(r.body.error!.message, label).toContain(part);
      expect(r.calls, label).toHaveLength(0);
    }
  });

  it("allows exactly 200 entries and a file just under 256 KB", async () => {
    const exact = { resources: Array.from({ length: 200 }, (_, i) => ({ name: `r${i}`, list: route({ path: `/api/r${i}` }) })) };
    const ok = await cli(["resources", "--resources", "big.json"], { files: { "big.json": JSON.stringify(exact) } });
    expect(ok.code).toBe(0);
    expect(ok.body.result).toHaveLength(202);
    const pad = JSON.stringify({ resources: [] }) + " ".repeat(256 * 1024 - JSON.stringify({ resources: [] }).length);
    const edge = await cli(["resources", "--resources", "edge.json"], { files: { "edge.json": pad } });
    expect(edge.code).toBe(0);
  });
});

describe("resources", () => {
  it("lists built in and file entries with their verbs and source", async () => {
    const r = await cli(["resources", "--resources", "res.json"], { files: FILES, env: { BARAKO_URL: "", BARAKO_API_KEY: "" } });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(0);
    const byName = Object.fromEntries((r.body.result as Array<{ name: string; routes: Record<string, string> }>).map((e) => [e.name, e])) as Record<string, any>;
    expect(Object.keys(byName)).toEqual(["contents", "content-types", "invoices"]);
    expect(byName.contents).toMatchObject({
      source: "built in",
      verbs: ["list", "get", "create", "update"],
      dryRun: ["create", "update"],
    });
    expect(byName.contents.routes).toMatchObject({ update: "PUT /api/contents/{id}" });
    expect(byName.invoices).toMatchObject({
      source: "file",
      verbs: ["list", "get", "create", "update", "delete"],
      dryRun: ["create"],
    });
    expect(byName.invoices.routes).toMatchObject({ delete: "DELETE /api/modules/invoices/{id}" });
  });

  it("lists only the built in resources when no file is given", async () => {
    const r = await cli(["resources"]);
    expect((r.body.result as Array<{ source: string }>).map((e) => e.source)).toEqual(["built in", "built in"]);
  });
});

describe("the definitions file loader", () => {
  it("checks the definitions itself, without a client", () => {
    const files: Record<string, string> = { "f.json": JSON.stringify({ resources: [{ name: "x", list: { method: "GET", path: "/nope" } }] }) };
    const load = () => loadResourcesFile("f.json", (p) => files[p]!);
    expect(load).toThrow("The resources file is refused. Invalid resource");
    expect(load).toThrow(`"path" must start with /api/`);
  });

  it("stops with a usage error naming client 0.6.0 when the client module lacks checkResourceDefinitions", () => {
    let message = "";
    let code = "";
    try {
      loadResourcesFile("f.json", () => "{}", { BUILTIN_RESOURCES: [], RESOURCE_VERBS: [], routeLabel: () => "", verbsOf: () => [] });
    } catch (e) {
      message = (e as Error).message;
      code = (e as { code: string }).code;
    }
    expect(code).toBe("usage");
    expect(message).toContain("@baryodev/barako-client 0.6.0 or later");
  });

  it("refuses a duplicate name inside one file", async () => {
    const files = { "d.json": JSON.stringify({ resources: [INVOICES, INVOICES] }) };
    const r = await cli(["resources", "--resources", "d.json"], { files });
    expect(r.code).toBe(1);
    expect(r.body.error!.message).toContain(`"invoices": "name" is already taken`);
  });

  it("refuses a __proto__ key on a definition and on a route", async () => {
    const onDef = `{"resources":[{"name":"x","__proto__":{}}]}`;
    const onRoute = `{"resources":[{"name":"x","list":{"method":"GET","path":"/api/x","__proto__":{}}}]}`;
    for (const text of [onDef, onRoute]) {
      const r = await cli(["resources", "--resources", "p.json"], { files: { "p.json": text } });
      expect(r.code).toBe(1);
      expect(r.body.error!.message).toContain("an unknown key.");
    }
  });

  it("does not echo an unknown key that holds escape bytes or is 1000 characters long", async () => {
    for (const key of ["\u001b[31mred", "k".repeat(1000)]) {
      const text = JSON.stringify({ resources: [{ name: "x", [key]: 1 }] });
      const r = await cli(["resources", "--resources", "k.json"], { files: { "k.json": text } });
      expect(r.code).toBe(1);
      expect(r.body.error!.message).toContain("an unknown key.");
      expect(r.body.error!.message).not.toContain("\u001b");
      expect(r.body.error!.message.length).toBeLessThan(300);
    }
  });
});

describe("a client without the resource API", () => {
  const verbs: Array<[string, Record<string, unknown>]> = [
    ["get", { resource: "contents", id: "c1" }],
    ["list", { resource: "contents" }],
    ["create", { resource: "contents", set: ["a=b"] }],
    ["update", { resource: "contents", id: "c1", set: ["a=b"] }],
    ["delete", { resource: "contents", id: "c1", confirm: "c1" }],
  ];

  it("stops get, list, create, update and delete with a usage error naming client 0.6.0, before any request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const [name, args] of verbs) {
      const command = commands.find((c) => c.name === name)!;
      let err: { code?: string; message?: string } = {};
      try {
        await command.run({ client: {} as unknown as BarakoClient, readFile: () => "" }, args);
      } catch (e) {
        err = e as { code: string; message: string };
      }
      expect(err.code, name).toBe("usage");
      expect(err.message, name).toContain("@baryodev/barako-client 0.6.0 or later");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the definitions file is read only for the generic verbs", () => {
  it("does not stop content list when BARAKO_RESOURCES names a file that is missing", async () => {
    const r = await cli(["content", "list", "post"], {
      env: { BARAKO_RESOURCES: "missing.json" },
      reply: () => ({ body: { items: [], hasNextPage: false } }),
    });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
  });

  it("fails a generic verb with a usage error when BARAKO_RESOURCES names a bad file", async () => {
    const r = await cli(["list", "contents"], { env: { BARAKO_RESOURCES: "bad.json" }, files: { "bad.json": "{ nope" } });
    expect(r.code).toBe(1);
    expect(r.body.error!.message).toContain("not valid JSON");
    expect(r.calls).toHaveLength(0);
  });
});

describe("the CLI imports from the client", () => {
  // The values client 0.5.0 exports. Anything else must be read through client-api.ts at call time.
  const EXPORTED_BY_0_5_0 = ["BarakoError", "ContentStatus", "FieldMask", "SensitivityLevel", "browserStore", "createClient", "memoryStore", "tenantOfToken"];

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sources(full);
      return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
    });
  }

  it("names only values that client 0.5.0 exports, as value imports", () => {
    const found: string[] = [];
    for (const file of sources(join(__dirname, ".."))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']@baryodev\/barako-client["']/g)) {
        if (m[1]) continue;
        for (const part of m[2]!.split(",")) {
          const item = part.trim();
          if (item === "" || item.startsWith("type ")) continue;
          found.push(item.split(/\s+as\s+/)[0]!);
        }
      }
    }
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((n) => !EXPORTED_BY_0_5_0.includes(n))).toEqual([]);
  });
});

describe("content rollback and content erase", () => {
  it("still say entry id for a missing and for a different --confirm", async () => {
    const client = { contents: { rollback: vi.fn(), erase: vi.fn() } } as unknown as BarakoClient;
    const exec = (name: string, args: Record<string, unknown>) =>
      commands.find((c) => c.name === name)!.run({ client, readFile: () => "" }, args);
    const message = async (name: string, args: Record<string, unknown>) => {
      try {
        await exec(name, args);
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    };
    expect(await message("content rollback", { id: "a", versionId: "v" })).toBe("This command is destructive. Pass --confirm with the entry id.");
    expect(await message("content erase", { id: "a" })).toBe("This command is destructive. Pass --confirm with the entry id.");
    expect(await message("content rollback", { id: "a", versionId: "v", confirm: "b" })).toBe("--confirm does not match the entry id. Nothing was changed.");
    expect(await message("content erase", { id: "a", confirm: "b" })).toBe("--confirm does not match the entry id. Nothing was changed.");
  });
});

describe("generic update body and errors", () => {
  const row = (extra: Record<string, unknown> = {}) => ({ id: "i1", version: 3, ...extra });

  it("accepts a --set id equal to the URL id and sends the URL id", async () => {
    const r = await cli(["update", "invoices", "i1", "--set", "id=i1", "--set", "total:=7", ...WITH_FILE], {
      files: FILES,
      reply: (c) => (c.method === "GET" ? { body: row() } : { body: {} }),
    });
    expect(r.code).toBe(0);
    expect(r.calls[1]!.body).toEqual({ id: "i1", total: 7, version: 3 });
    const num = await cli(["update", "invoices", "1", "--set", "id:=1", "--set", "total:=7", ...WITH_FILE], {
      files: FILES,
      reply: (c) => (c.method === "GET" ? { body: { id: "1", version: 3 } } : { body: {} }),
    });
    expect(num.calls[1]!.body).toEqual({ id: "1", total: 7, version: 3 });
  });

  it("refuses a --set id that differs from the URL id, naming both, before any request", async () => {
    const r = await cli(["update", "invoices", "i1", "--set", "id=other", ...WITH_FILE], { files: FILES });
    expect(r.code).toBe(1);
    expect(r.body.error!.message).toContain("other");
    expect(r.body.error!.message).toContain("i1");
    expect(r.calls).toHaveLength(0);
  });

  it("sends named top level fields when a route has no merge, even if the row has a data column", async () => {
    const withData = await cli(["update", "invoices", "i1", "--set", "total:=7", ...WITH_FILE], {
      files: FILES,
      reply: (c) => (c.method === "GET" ? { body: row({ data: { total: 1, keep: true } }) } : { body: {} }),
    });
    expect(withData.calls[1]!.body).toEqual({ total: 7, id: "i1", version: 3 });
    const nullData = await cli(["update", "invoices", "i1", "--set", "total:=7", ...WITH_FILE], {
      files: FILES,
      reply: (c) => (c.method === "GET" ? { body: row({ data: null }) } : { body: {} }),
    });
    expect(nullData.calls[1]!.body).toEqual(withData.calls[1]!.body);
  });

  it("merges into data on a route marked merge data, and starts from an empty data when the row has none", async () => {
    const merging = { ...INVOICES, update: { ...INVOICES.update, merge: "data" } };
    const files = { "m.json": JSON.stringify({ resources: [merging] }) };
    const kept = await cli(["update", "invoices", "i1", "--set", "total:=7", "--resources", "m.json"], {
      files,
      reply: (c) => (c.method === "GET" ? { body: row({ data: { total: 1, keep: true } }) } : { body: {} }),
    });
    expect(kept.calls[1]!.body).toEqual({ id: "i1", data: { total: 7, keep: true }, version: 3 });
    const none = await cli(["update", "invoices", "i1", "--set", "total:=7", "--resources", "m.json"], {
      files,
      reply: (c) => (c.method === "GET" ? { body: row({ data: null }) } : { body: {} }),
    });
    expect(none.calls[1]!.body).toEqual({ id: "i1", data: { total: 7 }, version: 3 });
  });

  it("refuses a dryRun field from --set or --file on an unmarked and on a marked route, before any request", async () => {
    const dry = { "d.json": JSON.stringify({ dryRun: true, total: 1 }) };
    const files = { ...FILES, ...dry };
    const cases: string[][] = [
      ["create", "content-types", "--set", "dryRun:=true"],
      ["create", "invoices", "--set", "dryRun:=true", ...WITH_FILE],
      ["create", "invoices", "--file", "d.json", ...WITH_FILE],
      ["update", "invoices", "i1", "--set", "dryRun:=true", ...WITH_FILE],
      ["update", "invoices", "i1", "--file", "d.json", ...WITH_FILE],
    ];
    for (const argv of cases) {
      const r = await cli(argv, { files });
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.body.error!.message, argv.join(" ")).toContain("--dry-run");
      expect(r.calls, argv.join(" ")).toHaveLength(0);
    }
  });

  it("re-reads the row and reports its current version on a 409, 412 and 428 from the update", async () => {
    for (const status of [409, 412, 428]) {
      let gets = 0;
      const r = await cli(["update", "invoices", "i1", "--set", "total:=7", ...WITH_FILE], {
        files: FILES,
        reply: (c) => {
          if (c.method === "PUT") return { status, body: { message: "stale" } };
          gets++;
          return { body: row({ version: gets === 1 ? 3 : 7 }) };
        },
      });
      expect(r.summary.map((x) => x.split(" ")[0]), String(status)).toEqual(["GET", "PUT", "GET"]);
      expect(r.body.error!.code, String(status)).toBe(status === 428 ? "version_required" : "conflict");
      expect(r.code, String(status)).toBe(3);
      expect((r.body.error as any).details.currentVersion, String(status)).toBe(7);
    }
  });

  it("names the route on a 403 from the update PUT", async () => {
    const r = await cli(["update", "invoices", "i1", "--set", "total:=7", ...WITH_FILE], {
      files: FILES,
      reply: (c) => (c.method === "PUT" ? { status: 403, body: {} } : { body: row() }),
    });
    expect(r.code).toBe(5);
    expect(r.body.error!.message).toContain("PUT /api/modules/invoices/{id}");
  });
});

describe("generic list page size", () => {
  it("refuses --query pageSize together with --limit, before any request", async () => {
    const r = await cli(["list", "invoices", "--query", "pageSize=5", "--limit", "9", ...WITH_FILE], { files: FILES });
    expect(r.code).toBe(1);
    expect(r.body.error!.message).toContain("--limit");
    expect(r.calls).toHaveLength(0);
  });

  it("sends no page size by default", async () => {
    const r = await cli(["list", "invoices", ...WITH_FILE], { files: FILES });
    expect(r.calls[0]!.url).toBe(`${BASE}/api/modules/invoices`);
  });
});

describe("an Invalid resource TypeError from the client", () => {
  it("maps to a usage error, as an Invalid path segment one does", () => {
    const e = toCliError(new TypeError("Invalid resource call: unknown resource."));
    expect(e.code).toBe("usage");
    expect(e.message).toBe("Invalid resource call: unknown resource.");
    expect(toCliError(new TypeError("Something else entirely")).code).not.toBe("usage");
  });
});
