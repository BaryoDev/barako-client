import { describe, expect, it, vi } from "vitest";
import { BarakoError, type BarakoClient } from "@baryodev/barako-client";
import { commands } from "../registry";
import "./destructive";

function exec(name: string, contents: Record<string, unknown>, args: Record<string, unknown>) {
  const c = commands.find((x) => x.name === name)!;
  return c.run({ client: { contents } as unknown as BarakoClient, readFile: () => "" }, args);
}

async function fails(fn: () => Promise<unknown>): Promise<{ code: string; message: string; status?: number }> {
  try {
    await fn();
  } catch (e) {
    return e as { code: string; message: string; status?: number };
  }
  throw new Error("expected the command to fail");
}

describe("destructive commands", () => {
  it("a missing --confirm is usage and makes no call", async () => {
    const rollback = vi.fn();
    const erase = vi.fn();
    expect((await fails(() => exec("content rollback", { rollback }, { id: "a", versionId: "v" }))).code).toBe("usage");
    expect((await fails(() => exec("content erase", { erase }, { id: "a" }))).code).toBe("usage");
    expect(rollback).not.toHaveBeenCalled();
    expect(erase).not.toHaveBeenCalled();
  });

  it("a different --confirm is usage, makes no call and does not echo values", async () => {
    const erase = vi.fn();
    const e = await fails(() => exec("content erase", { erase }, { id: "secret-id", confirm: "other-id" }));
    expect(e.code).toBe("usage");
    expect(e.message).toContain("--confirm");
    expect(e.message).not.toContain("secret-id");
    expect(e.message).not.toContain("other-id");
    expect(erase).not.toHaveBeenCalled();
  });

  it("a matching --confirm calls rollback and erase", async () => {
    const rollback = vi.fn().mockResolvedValue({ id: "a" });
    const erase = vi.fn().mockResolvedValue(undefined);
    await exec("content rollback", { rollback }, { id: "a", versionId: "v1", confirm: "a" });
    await exec("content erase", { erase }, { id: "a", confirm: "a" });
    expect(rollback).toHaveBeenCalledWith("a", "v1");
    expect(erase).toHaveBeenCalledWith("a");
  });

  it("a 403 is forbidden, keeps status 403 and names the scope", async () => {
    const erase = vi.fn().mockRejectedValue(new BarakoError(403, "Forbidden"));
    const e = await fails(() => exec("content erase", { erase }, { id: "a", confirm: "a" }));
    expect(e.code).toBe("forbidden");
    expect(e.status).toBe(403);
    expect(e.message).toContain("content:destructive");
  });
});
