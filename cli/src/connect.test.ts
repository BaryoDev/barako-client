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
      { BARAKO_URL: "https://x", BARAKO_API_KEY: "from-env" },
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
    const { secret } = connect({ BARAKO_URL: "https://x", BARAKO_API_KEY: "e" }, {}, noFile);
    expect(secret).toBe("e");
  });

  describe("plain http", () => {
    const env = (url: string, extra: Record<string, string> = {}) => ({ BARAKO_URL: url, BARAKO_API_KEY: "k", ...extra });
    const refused = (fn: () => unknown) => {
      try {
        fn();
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(CliError);
        expect((e as CliError).code).toBe("usage");
        expect((e as CliError).message).toContain("--allow-http");
        expect((e as CliError).message).toContain("BARAKO_ALLOW_HTTP");
      }
    };

    it("refuses a key over http to a remote host", () => {
      refused(() => connect(env("http://cms.example.com"), {}, noFile));
      refused(() => connect({ BARAKO_API_KEY: "k" }, { url: "http://cms.example.com:8080" }, noFile));
      refused(() => connect(env("http://api:8080"), {}, noFile));
    });

    it("allows https", () => {
      expect(connect(env("https://cms.example.com"), {}, noFile).secret).toBe("k");
    });

    it("allows each loopback form", () => {
      for (const url of ["http://localhost:5188", "http://127.0.0.1:5188", "http://127.1.2.3", "http://[::1]:5188"]) {
        expect(connect(env(url), {}, noFile).secret).toBe("k");
      }
    });

    it("allows a remote http host with the --allow-http flag", () => {
      expect(connect(env("http://api:8080"), { allowHttp: true }, noFile).secret).toBe("k");
    });

    it("allows a remote http host with BARAKO_ALLOW_HTTP", () => {
      expect(connect(env("http://api:8080", { BARAKO_ALLOW_HTTP: "1" }), {}, noFile).secret).toBe("k");
      refused(() => connect(env("http://api:8080", { BARAKO_ALLOW_HTTP: "0" }), {}, noFile));
    });
  });
});
