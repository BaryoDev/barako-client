import { describe, expect, it } from "vitest";
import { trimTrailingSlashes } from "./path";

describe("trimTrailingSlashes", () => {
  it("leaves a base url with no trailing slash alone", () => {
    expect(trimTrailingSlashes("https://cms.test")).toBe("https://cms.test");
    expect(trimTrailingSlashes("https://cms.test/barakocms-api")).toBe("https://cms.test/barakocms-api");
  });

  it("removes one or many trailing slashes", () => {
    expect(trimTrailingSlashes("https://cms.test/")).toBe("https://cms.test");
    expect(trimTrailingSlashes("https://cms.test/api///")).toBe("https://cms.test/api");
  });

  it("keeps slashes that are not at the end", () => {
    expect(trimTrailingSlashes("/a//b/")).toBe("/a//b");
    expect(trimTrailingSlashes("//host")).toBe("//host");
  });

  it("returns an empty string for an empty string", () => {
    expect(trimTrailingSlashes("")).toBe("");
  });

  it("returns an empty string when the input is only slashes", () => {
    expect(trimTrailingSlashes("/")).toBe("");
    expect(trimTrailingSlashes("////")).toBe("");
  });

  it("matches the old regex on mixed inputs", () => {
    for (const s of ["", "/", "a", "a/", "a//", "/a", "//a//", "a/b/", "a /", "a/ ", "a\n/"]) {
      expect(trimTrailingSlashes(s)).toBe(s.replace(/\/+$/, ""));
    }
  });

  it("returns quickly on a long run of slashes followed by another character", () => {
    const input = "/".repeat(50000) + "x";
    const start = Date.now();
    expect(trimTrailingSlashes(input)).toBe(input);
    expect(trimTrailingSlashes("/".repeat(50000))).toBe("");
    expect(Date.now() - start).toBeLessThan(200);
  });
});
