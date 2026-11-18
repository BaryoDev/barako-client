import { describe, expect, it } from "vitest";
import { mergeData, parseSets, readDataFile } from "./fields";
import { CliError } from "./output";

const noFile = () => {
  throw new Error("no file");
};

function usage(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).code).toBe("usage");
    return e as CliError;
  }
  throw new Error("expected a usage error");
}

describe("parseSets", () => {
  it("reads Title=Hello as a string", () => {
    expect(parseSets(["Title=Hello"], [], noFile)).toEqual({ Title: "Hello" });
  });

  it("splits on the first = only", () => {
    expect(parseSets(["Title=a=b"], [], noFile)).toEqual({ Title: "a=b" });
  });

  it("reads an empty value as an empty string", () => {
    expect(parseSets(["Title="], [], noFile)).toEqual({ Title: "" });
  });

  it("parses Name:=json booleans and arrays", () => {
    expect(parseSets(["Featured:=true", 'Tags:=["a","b"]'], [], noFile)).toEqual({
      Featured: true,
      Tags: ["a", "b"],
    });
  });

  it("rejects invalid JSON after := as usage without echoing the value", () => {
    const e = usage(() => parseSets(["Count:=bad"], [], noFile));
    expect(e.message).toContain("Count");
    expect(e.message).not.toContain("bad");
  });

  it("rejects an empty name as usage", () => {
    usage(() => parseSets(["=x"], [], noFile));
  });

  it("rejects an argument with no = as usage and does not echo it", () => {
    const e = usage(() => parseSets(["secret-token"], [], noFile));
    expect(e.message).not.toContain("secret-token");
  });

  it("rejects the same name twice across --set and --set-file", () => {
    usage(() => parseSets(["Body=x"], ["Body=post.md"], () => "text"));
    usage(() => parseSets(["A=1", "A=2"], [], noFile));
  });

  it("reads --set-file Body=post.md as a string", () => {
    const paths: string[] = [];
    const out = parseSets([], ["Body=post.md"], (p) => {
      paths.push(p);
      return "# Hi\n";
    });
    expect(out).toEqual({ Body: "# Hi\n" });
    expect(paths).toEqual(["post.md"]);
  });

  it("reports an unreadable --set-file as usage naming the field only", () => {
    const e = usage(() => parseSets([], ["Body=/secret/path.md"], noFile));
    expect(e.message).toContain("Body");
    expect(e.message).not.toContain("/secret/path.md");
  });
});

describe("readDataFile", () => {
  it("rejects an array as usage", () => {
    usage(() => readDataFile("d.json", () => "[1,2]"));
  });

  it("rejects a string as usage", () => {
    usage(() => readDataFile("d.json", () => '"x"'));
  });

  it("rejects invalid JSON as usage", () => {
    usage(() => readDataFile("d.json", () => "{nope"));
  });

  it("returns an object", () => {
    expect(readDataFile("d.json", () => '{ "a": 1 }')).toEqual({ a: 1 });
  });
});

describe("mergeData", () => {
  it("replaces at the top level only", () => {
    expect(mergeData({ a: 1, b: { x: 1 } }, { b: { y: 2 } })).toEqual({ a: 1, b: { y: 2 } });
  });
});
