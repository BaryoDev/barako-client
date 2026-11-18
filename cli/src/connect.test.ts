import { describe, expect, it } from "vitest";
import { connect } from "./connect";
import { CliError } from "./output";

const noFile = () => {
  throw new Error("no file");
};

describe("connect", () => {
  it("fails with usage when the URL is missing", () => {
    expect(() => connect({ BARAKO_API_KEY: "k" }, {}, noFile)).toThrow(CliError);
    try {
      connect({ BARAKO_API_KEY: "k" }, {}, noFile);
    } catch (e) {
      expect((e as CliError).code).toBe("usage");
    }
  });

  it("fails with usage when the key is missing", () => {
    try {
      connect({ BARAKO_URL: "http://x" }, {}, noFile);
      expect.unreachable();
    } catch (e) {
      expect((e as CliError).code).toBe("usage");
    }
  });

  it("prefers --key-file over the env and trims trailing newlines", () => {
    const { secret } = connect(
      { BARAKO_URL: "http://x", BARAKO_API_KEY: "from-env" },
      { keyFile: "/k" },
      () => "from-file\n\n",
    );
    expect(secret).toBe("from-file");
  });

  it("treats an empty --key-file as a usage error, not as absent", () => {
    try {
      connect({ BARAKO_URL: "http://x", BARAKO_API_KEY: "e" }, { keyFile: "" }, noFile);
      expect.unreachable();
    } catch (e) {
      expect((e as CliError).code).toBe("usage");
    }
  });

  it("uses the env key and URL otherwise", () => {
    const { secret } = connect({ BARAKO_URL: "http://x", BARAKO_API_KEY: "e" }, {}, noFile);
    expect(secret).toBe("e");
  });
});
