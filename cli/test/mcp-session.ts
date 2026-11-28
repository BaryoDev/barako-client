import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

/** Runs `barako mcp` with a key. Each step is sent after the reply to the one before it came back, so an
 *  apply step can read the token from the plan reply. Returns every reply and what the process wrote. */
export async function mcpSession(base: string, key: string, flags: string[], steps: ((replies: any[]) => object)[]) {
  const child = spawn(process.execPath, [MAIN, "mcp", ...flags], {
    env: { PATH: process.env.PATH, BARAKO_URL: base, BARAKO_API_KEY: key },
  });
  let stdout = "";
  let stderr = "";
  let pending = "";
  const replies: any[] = [];
  child.stdout.setEncoding("utf8").on("data", (d: string) => {
    stdout += d;
    pending += d;
    for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
      replies.push(JSON.parse(pending.slice(0, nl)));
      pending = pending.slice(nl + 1);
    }
  });
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  for (const [i, step] of steps.entries()) {
    child.stdin.write(JSON.stringify(step(replies)) + "\n");
    const deadline = Date.now() + 30_000;
    while (replies.length <= i) {
      if (Date.now() > deadline) throw new Error("No reply from barako mcp.");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  child.stdin.end();
  expect(await closed).toBe(0);
  // A boolean, so a failure never prints the key the way a string match would.
  expect(stdout.includes(key)).toBe(false);
  expect(stderr.includes(key)).toBe(false);
  return replies;
}

export const toolCall = (id: number, name: string, args: object) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
export const resultData = (reply: any) => JSON.parse(reply.result.content[0].text).data;
export const applyOf = (name: string, id: number, planIndex: number) => (replies: any[]) => {
  const plan = resultData(replies[planIndex]);
  return toolCall(id, name, { token: plan.token, action: plan.action, target: plan.target });
};
