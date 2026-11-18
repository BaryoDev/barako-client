import { describe, expect, it, vi } from "vitest";
import { BarakoError, type BarakoClient } from "@baryodev/barako-client";
import { commands } from "../registry";
import "./status";

function exec(name: string, contents: Record<string, unknown>, args: Record<string, unknown>) {
  const c = commands.find((x) => x.name === name)!;
  return c.run({ client: { contents } as unknown as BarakoClient, readFile: () => "" }, args);
}

async function fails(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await fn();
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected the command to fail");
}

describe("status commands", () => {
  it("publish, unpublish and archive call setStatus with 1, 0 and 2", async () => {
    const setStatus = vi.fn().mockResolvedValue({});
    await exec("content publish", { setStatus }, { id: "a" });
    await exec("content unpublish", { setStatus }, { id: "a" });
    await exec("content archive", { setStatus }, { id: "a" });
    expect(setStatus.mock.calls.map((c) => c[1])).toEqual([1, 0, 2]);
  });

  it("restore on an archived entry calls setStatus with 0", async () => {
    const get = vi.fn().mockResolvedValue({ status: "Archived" });
    const setStatus = vi.fn().mockResolvedValue({});
    await exec("content restore", { get, setStatus }, { id: "a" });
    expect(setStatus).toHaveBeenCalledWith("a", 0);
  });

  it("restore on a published entry is a usage error that names unpublish", async () => {
    const get = vi.fn().mockResolvedValue({ status: "Published" });
    const setStatus = vi.fn();
    const e = await fails(() => exec("content restore", { get, setStatus }, { id: "a" }));
    expect(e.code).toBe("usage");
    expect(e.message).toContain("unpublish");
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("publish --dry-run writes nothing and reports the move", async () => {
    const get = vi.fn().mockResolvedValue({ status: "Draft" });
    const setStatus = vi.fn();
    const out = await exec("content publish", { get, setStatus }, { id: "a", "dry-run": true });
    expect(out).toEqual({ dryRun: true, checkedBy: "client", from: "draft", to: "published" });
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("publish on a lifecycle type turns the 400 into a validation error naming transition", async () => {
    const setStatus = vi.fn().mockRejectedValue(new BarakoError(400, "Use a transition"));
    const e = await fails(() => exec("content publish", { setStatus }, { id: "a" }));
    expect(e.code).toBe("validation");
    expect(e.message).toContain("barako content transition");
  });

  it("schedule with a non-ISO --publish-at is a usage error", async () => {
    const get = vi.fn();
    const schedule = vi.fn();
    const e = await fails(() => exec("content schedule", { get, schedule }, { id: "a", "publish-at": "tomorrow" }));
    expect(e.code).toBe("usage");
    expect(schedule).not.toHaveBeenCalled();
  });

  it("schedule sends unpublishAt null when --unpublish-at is absent", async () => {
    const get = vi.fn().mockResolvedValue({ version: 3 });
    const schedule = vi.fn().mockResolvedValue({});
    await exec("content schedule", { get, schedule }, { id: "a", "publish-at": "2026-12-01T09:00:00Z" });
    expect(schedule).toHaveBeenCalledWith("a", { publishAt: "2026-12-01T09:00:00Z", unpublishAt: null, version: 3 });
  });

  it("schedule sends no version for version 0 when the entry has an etag", async () => {
    const get = vi.fn().mockResolvedValue({ version: 0, etag: '"e1"' });
    const schedule = vi.fn().mockResolvedValue({});
    await exec("content schedule", { get, schedule }, { id: "a", "publish-at": "2026-12-01T09:00:00Z" });
    expect(schedule).toHaveBeenCalledWith("a", { publishAt: "2026-12-01T09:00:00Z", unpublishAt: null });
  });

  it("schedule refuses with version_required when there is no version and no etag", async () => {
    const get = vi.fn().mockResolvedValue({ version: 0 });
    const schedule = vi.fn();
    const e = await fails(() => exec("content schedule", { get, schedule }, { id: "a", "publish-at": "2026-12-01T09:00:00Z" }));
    expect(e.code).toBe("version_required");
    expect(schedule).not.toHaveBeenCalled();
  });

  it("passes a 400 that does not mention a lifecycle through as validation", async () => {
    const setStatus = vi.fn().mockRejectedValue(new BarakoError(400, "Invalid status value"));
    const e = await fails(() => exec("content publish", { setStatus }, { id: "a" }));
    expect(e.code).toBe("validation");
    expect(e.message).not.toContain("barako content transition");
  });

  it("transition sends data from --set", async () => {
    const transition = vi.fn().mockResolvedValue({});
    await exec("content transition", { transition }, { id: "a", name: "approve", set: ["Reason=ok"] });
    expect(transition).toHaveBeenCalledWith("a", "approve", { Reason: "ok" });
  });

  it("schedule with --unpublish-at sends both times", async () => {
    const get = vi.fn().mockResolvedValue({ version: 2 });
    const schedule = vi.fn().mockResolvedValue({});
    await exec("content schedule", { get, schedule }, { id: "a", "publish-at": "2026-12-01T09:00:00Z", "unpublish-at": "2027-01-01T09:00:00Z" });
    expect(schedule).toHaveBeenCalledWith("a", { publishAt: "2026-12-01T09:00:00Z", unpublishAt: "2027-01-01T09:00:00Z", version: 2 });
  });
});
