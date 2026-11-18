import { describe, expect, it } from "vitest";
import { BarakoError } from "@baryodev/barako-client";
import { CliError, codeForStatus, exitFor, render, toCliError, type ErrorCode } from "./output";

describe("codeForStatus", () => {
  it.each([
    [400, "validation"],
    [422, "rule"],
    [409, "conflict"],
    [412, "conflict"],
    [428, "version_required"],
    [404, "not_found"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [500, "server"],
    [503, "server"],
  ])("maps %i to %s", (status, code) => {
    expect(codeForStatus(status)).toBe(code);
  });
});

describe("exitFor", () => {
  it.each<[ErrorCode, number]>([
    ["usage", 1],
    ["validation", 2],
    ["rule", 2],
    ["conflict", 3],
    ["version_required", 3],
    ["not_found", 4],
    ["unauthorized", 5],
    ["forbidden", 5],
    ["server", 6],
    ["network", 6],
  ])("maps %s to %i", (code, exit) => {
    expect(exitFor(code)).toBe(exit);
  });
});

describe("render", () => {
  it("prints ok results on stdout with exit 0", () => {
    const r = render({ ok: true, result: { a: 1 } }, "k");
    expect(r.stream).toBe("stdout");
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.text)).toEqual({ ok: true, result: { a: 1 } });
  });

  it("scrubs the secret from message and nested details", () => {
    const secret = "bcms_supersecret";
    const err = new CliError("server", `failed with ${secret}`, {
      status: 500,
      details: { header: `Bearer ${secret}`, nested: [{ deep: secret }], [secret]: 1 },
    });
    const r = render({ ok: false, error: err }, secret);
    expect(r.stream).toBe("stderr");
    expect(r.text).not.toContain(secret);
    expect(r.text).toContain("[redacted]");
    expect(JSON.parse(r.text).error.code).toBe("server");
  });

  it("scrubs the URL-encoded and JSON-escaped forms of the key", () => {
    const secret = 'a b/"c';
    const err = new CliError("server", "x", {
      details: { url: `http://h/?k=${encodeURIComponent(secret)}`, raw: JSON.stringify(secret) },
    });
    const r = render({ ok: false, error: err }, secret);
    expect(r.text).not.toContain(encodeURIComponent(secret));
    expect(r.text).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(r.text).toContain("[redacted]");
  });

  it("keeps the structure when the secret is a JSON word", () => {
    const r = render({ ok: true, result: { a: 1 } }, "ok");
    expect(JSON.parse(r.text)).toEqual({ ok: true, result: { a: 1 } });
  });

  it("keeps an object that appears twice in the result", () => {
    const shared = { n: 1 };
    const r = render({ ok: true, result: { x: shared, y: shared } }, "zzz");
    expect(JSON.parse(r.text).result).toEqual({ x: { n: 1 }, y: { n: 1 } });
  });

  it("scrubs a secret shorter than 8 characters", () => {
    const r = render({ ok: false, error: new CliError("usage", "bad abc") }, "abc");
    expect(r.text).not.toContain("abc");
  });
});

describe("toCliError", () => {
  it("maps a fetch TypeError to network, exit 6", () => {
    const e = toCliError(new TypeError("fetch failed"));
    expect(e.code).toBe("network");
    expect(exitFor(e.code)).toBe(6);
  });

  it("maps a BarakoError by status and keeps the body as details", () => {
    const e = toCliError(new BarakoError(404, "nope", { x: 1 }));
    expect(e.code).toBe("not_found");
    expect(e.status).toBe(404);
    expect(e.details).toEqual({ x: 1 });
  });

  it("maps a path segment TypeError to usage, exit 1", () => {
    const e = toCliError(new TypeError('Invalid path segment: ".."'));
    expect(e.code).toBe("usage");
    expect(exitFor(e.code)).toBe(1);
  });

  it("maps an abort to network", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(toCliError(e).code).toBe("network");
  });

  it("passes a CliError through", () => {
    const c = new CliError("usage", "m");
    expect(toCliError(c)).toBe(c);
  });
});
