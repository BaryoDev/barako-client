import { describe, expect, it } from "vitest";
import { run } from "./main";

function harness() {
  const out: { stream: string; text: string }[] = [];
  return {
    out,
    io: {
      readFile: () => "",
      write: (stream: "stdout" | "stderr", text: string) => out.push({ stream, text }),
    },
  };
}

describe("run", () => {
  it("rejects --api-key with a message pointing at BARAKO_API_KEY or --key-file", async () => {
    const h = harness();
    const code = await run(["content", "list", "post", "--api-key", "x"], {}, h.io);
    expect(code).toBe(1);
    const body = JSON.parse(h.out[0]!.text);
    expect(body.error.code).toBe("usage");
    expect(body.error.message).toContain("BARAKO_API_KEY");
    expect(body.error.message).toContain("--key-file");
  });

  it("lists commands with name, summary and args", async () => {
    const h = harness();
    const code = await run(["commands"], {}, h.io);
    expect(code).toBe(0);
    expect(h.out[0]!.stream).toBe("stdout");
    const body = JSON.parse(h.out[0]!.text);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.result)).toBe(true);
    for (const item of body.result) {
      expect(item).toHaveProperty("name");
      expect(item).toHaveProperty("summary");
      expect(item).toHaveProperty("args");
    }
  });

  it("exits 1 with usage for an unknown command", async () => {
    const h = harness();
    const code = await run(["nope"], {}, h.io);
    expect(code).toBe(1);
    expect(JSON.parse(h.out[0]!.text).error.code).toBe("usage");
  });

  it("runs commands with an empty env and exits 0", async () => {
    const h = harness();
    expect(await run(["commands"], {}, h.io)).toBe(0);
  });

  it("never prints the key when it is passed as an unknown flag", async () => {
    const h = harness();
    const key = "bcms_leakme123";
    const code = await run(["commands", "--apiKey", key], { BARAKO_API_KEY: key }, h.io);
    expect(code).toBe(1);
    const all = h.out.map((o) => o.text).join("");
    expect(all).not.toContain(key);
    const h2 = harness();
    await run(["commands", `--apiKey=${key}`, key], { BARAKO_API_KEY: key }, h2.io);
    expect(h2.out.map((o) => o.text).join("")).not.toContain(key);
  });

  it("scrubs both the env key and the key file key from a failure", async () => {
    const h = harness();
    h.io.readFile = () => "file-key-999\n";
    const code = await run(
      ["commands", "--bogus", "--key-file", "/k"],
      { BARAKO_API_KEY: "env-key-111", BARAKO_URL: "http://x" },
      h.io,
    );
    expect(code).toBe(1);
    const all = h.out.map((o) => o.text).join("");
    expect(all).not.toContain("env-key-111");
    expect(all).not.toContain("file-key-999");
  });
});
