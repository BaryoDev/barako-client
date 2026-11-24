import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Needs only the built CLI (dist/main.js), no server. `barako mcp` must end quietly when the client
// closes the pipe it reads from, with no stack trace.

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

describe.skipIf(!existsSync(MAIN))("barako mcp when the client closes the pipe", () => {
  it("stops without a stack trace and exits 0", async () => {
    const child = spawn(process.execPath, [MAIN, "mcp"], {
      env: { PATH: process.env.PATH, BARAKO_URL: "https://cms.invalid", BARAKO_API_KEY: "bcms_ro_pipe_test" },
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
    child.stdin.on("error", () => {});
    // The client goes away: close our end of the server's stdout, then keep sending.
    child.stdout.destroy();
    for (let i = 1; i <= 5; i++) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping" }) + "\n");
      await new Promise((r) => setTimeout(r, 50));
    }
    child.stdin.end();
    const code = await closed;
    expect(stderr).not.toMatch(/EPIPE|Error:|\n\s+at /);
    expect(code).toBe(0);
  }, 20_000);
});
