import { describe, expect, it, vi } from "vitest";
import { BarakoError, type BarakoClient } from "@baryodev/barako-client";
import { commands } from "../registry";
import "./write";

function exec(name: string, contents: Record<string, unknown>, args: Record<string, unknown>, files: Record<string, string> = {}) {
  const c = commands.find((x) => x.name === name)!;
  const client = { contents } as unknown as BarakoClient;
  return c.run({ client, readFile: (p) => files[p] ?? "" }, args);
}

async function fails(fn: () => Promise<unknown>): Promise<{ code: string; details?: any }> {
  try {
    await fn();
  } catch (e) {
    return e as { code: string; details?: any };
  }
  throw new Error("expected the command to fail");
}

const entry = (over: Record<string, unknown> = {}) => ({
  id: "i1",
  contentType: "post",
  status: "Draft",
  version: 5,
  data: { Title: "x", Body: "b" },
  etag: '"e5"',
  ...over,
});

describe("content create", () => {
  it("creates a draft by default", async () => {
    const create = vi.fn().mockResolvedValue({ id: "n", version: 1 });
    await exec("content create", { create }, { type: "post", set: ["Title=x"] });
    expect(create).toHaveBeenCalledWith({ contentType: "post", data: { Title: "x" }, status: 0 }, {});
  });

  it("publishes with --publish", async () => {
    const create = vi.fn().mockResolvedValue({});
    await exec("content create", { create }, { type: "post", set: ["Title=x"], publish: true });
    expect(create.mock.calls[0]![0].status).toBe(1);
  });

  it("passes the idempotency key", async () => {
    const create = vi.fn().mockResolvedValue({});
    await exec("content create", { create }, { type: "post", set: ["Title=x"], "idempotency-key": "k" });
    expect(create.mock.calls[0]![1]).toEqual({ idempotencyKey: "k" });
  });

  it("passes dryRun and returns the changes", async () => {
    const create = vi.fn().mockResolvedValue({ dryRun: true, changes: [] });
    const out = await exec("content create", { create }, { type: "post", set: ["Title=x"], "dry-run": true });
    expect(create.mock.calls[0]![1]).toEqual({ dryRun: true });
    expect(out).toMatchObject({ dryRun: true, changes: [] });
  });
});

describe("content update", () => {
  it("merges into the current data and sends version and ifMatch", async () => {
    const get = vi.fn().mockResolvedValue(entry());
    const update = vi.fn().mockResolvedValue({ id: "i1", version: 6 });
    await exec("content update", { get, update }, { id: "i1", set: ["Title=y"] });
    expect(get).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("i1", { data: { Title: "y", Body: "b" }, version: 5 }, { ifMatch: '"e5"' });
  });

  it("never sends version 0", async () => {
    const get = vi.fn().mockResolvedValue(entry({ version: 0 }));
    const update = vi.fn();
    const e = await fails(() => exec("content update", { get, update }, { id: "i1", set: ["Title=y"] }));
    expect(e.code).toBe("server");
    expect(update).not.toHaveBeenCalled();
  });

  it("stops on --expect-version mismatch with the current version", async () => {
    const get = vi.fn().mockResolvedValue(entry());
    const update = vi.fn();
    const e = await fails(() =>
      exec("content update", { get, update }, { id: "i1", set: ["Title=y"], "expect-version": 4 }),
    );
    expect(e.code).toBe("conflict");
    expect(e.details.currentVersion).toBe(5);
    expect(update).not.toHaveBeenCalled();
  });

  it("sends no ifMatch when the get has no etag", async () => {
    const get = vi.fn().mockResolvedValue(entry({ etag: undefined }));
    const update = vi.fn().mockResolvedValue({});
    await exec("content update", { get, update }, { id: "i1", set: ["Title=y"] });
    expect(update.mock.calls[0]![2]).toEqual({});
  });

  it("reads the version again after a 409", async () => {
    const get = vi.fn().mockResolvedValueOnce(entry({ etag: undefined })).mockResolvedValueOnce(entry({ version: 7 }));
    const update = vi.fn().mockRejectedValue(new BarakoError(409, "conflict"));
    const e = await fails(() => exec("content update", { get, update }, { id: "i1", set: ["Title=y"] }));
    expect(get).toHaveBeenCalledTimes(2);
    expect(e.code).toBe("conflict");
    expect(e.details.currentVersion).toBe(7);
  });

  it("treats a 412 like a 409", async () => {
    const get = vi.fn().mockResolvedValueOnce(entry()).mockResolvedValueOnce(entry({ version: 6 }));
    const update = vi.fn().mockRejectedValue(new BarakoError(412, "stale"));
    const e = await fails(() => exec("content update", { get, update }, { id: "i1", set: ["Title=y"] }));
    expect(e.code).toBe("conflict");
    expect(e.details.currentVersion).toBe(6);
  });

  it("maps a 428 to version_required", async () => {
    const get = vi.fn().mockResolvedValue(entry());
    const update = vi.fn().mockRejectedValue(new BarakoError(428, "needs version"));
    const e = await fails(() => exec("content update", { get, update }, { id: "i1", set: ["Title=y"] }));
    expect(e.code).toBe("version_required");
  });

  it("sends the file as data with --replace and no merge", async () => {
    const get = vi.fn().mockResolvedValue(entry());
    const update = vi.fn().mockResolvedValue({});
    await exec("content update", { get, update }, { id: "i1", replace: true, file: "e.json" }, { "e.json": '{"Only":"this"}' });
    expect(update.mock.calls[0]![1].data).toEqual({ Only: "this" });
  });

  it("returns dryRun and changes from update --dry-run and makes no write", async () => {
    const get = vi.fn().mockResolvedValue(entry());
    const update = vi.fn().mockResolvedValue({ dryRun: true, changes: [{ field: "Title" }] });
    const out = await exec("content update", { get, update }, { id: "i1", set: ["Title=y"], "dry-run": true });
    expect(update.mock.calls[0]![2]).toEqual({ ifMatch: '"e5"', dryRun: true });
    expect(out).toMatchObject({ dryRun: true, changes: [{ field: "Title" }] });
  });

  it("lets --set win over --file on the same key", async () => {
    const get = vi.fn().mockResolvedValue(entry());
    const update = vi.fn().mockResolvedValue({});
    await exec("content update", { get, update }, { id: "i1", file: "p.json", set: ["Title=set"] }, { "p.json": '{"Title":"file","Body":"fb"}' });
    expect(update.mock.calls[0]![1].data).toEqual({ Title: "set", Body: "fb" });
  });
});
