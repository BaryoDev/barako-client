import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyOf, mcpSession, resultData, toolCall } from "./mcp-session";

// Starts the real local stack from the published images, so it needs Docker and a network. It is
// skipped unless BARAKO_STACK_INT=1, which only the stack job in CI sets. The live jobs run the
// other int tests and must not start a stack. The state folder is a temporary HOME, so a developer's
// own ~/.barako/stack is never touched.

const ON = process.env.BARAKO_STACK_INT === "1";
const PORT = Number(process.env.BARAKO_STACK_PORT ?? 18080);
const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const API = "http://127.0.0.1:5005";

let home = "";
let stackDir = "";

interface Out {
  code: number;
  stdout: string;
  stderr: string;
}

function run(file: string, args: string[], env: Record<string, string | undefined> = {}, timeout = 60_000): Promise<Out> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout, env: { PATH: process.env.PATH, ...env } }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 99) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

const DOCKER_CONFIG = process.env.DOCKER_CONFIG ?? join(homedir(), ".docker");

const barako = (args: string[], timeout?: number) => run(process.execPath, [MAIN, ...args], { HOME: home, DOCKER_CONFIG }, timeout);

/**
 * The stack's containers by their compose label, so this works without the compose file and its
 * environment. Only these inspect fields: the rest holds the environment, and with it the secrets.
 */
async function containers(): Promise<{ id: string; line: string }[]> {
  const ids = await run("docker", ["ps", "-aq", "--filter", "label=com.docker.compose.project=barako"], { DOCKER_CONFIG });
  const out: { id: string; line: string }[] = [];
  for (const id of ids.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const r = await run("docker", [
      "inspect", "--format",
      '{{index .Config.Labels "com.docker.compose.service"}} {{.State.Status}} restarts={{.RestartCount}} started={{.State.StartedAt}}',
      id,
    ], { DOCKER_CONFIG });
    out.push({ id, line: (r.code === 0 ? r.stdout : r.stderr).trim() });
  }
  return out;
}

/** The status line and the redirect target of one request, with no redirect followed. */
async function curl(host: string, path: string): Promise<{ status: number; redirect: string; body: string }> {
  const marker = "\n__STATUS__";
  const r = await run("curl", [
    "-s", "--max-time", "20",
    "--resolve", `${host}:${PORT}:127.0.0.1`,
    "-w", `${marker}%{http_code} %{redirect_url}`,
    `http://${host}:${PORT}${path}`,
  ]);
  const at = r.stdout.lastIndexOf(marker);
  const [status = "0", redirect = ""] = r.stdout.slice(at + marker.length).split(" ");
  return { status: Number(status), redirect, body: r.stdout.slice(0, at) };
}

/** The status, the content type and the response headers of one request, with the body left out. */
async function headers(host: string, path: string): Promise<{ status: number; type: string; size: number; head: string }> {
  const marker = "\n__STATUS__";
  const r = await run("curl", [
    "-s", "--max-time", "20", "-o", "/dev/null", "-D", "-",
    "--resolve", `${host}:${PORT}:127.0.0.1`,
    "-w", `${marker}%{http_code} %{size_download} %{content_type}`,
    `http://${host}:${PORT}${path}`,
  ]);
  const at = r.stdout.lastIndexOf(marker);
  const [status = "0", size = "0", type = ""] = r.stdout.slice(at + marker.length).split(" ");
  return { status: Number(status), size: Number(size), type, head: r.stdout.slice(0, at) };
}

/** A 1x1 PNG, built here so the test carries no fixture file. */
function tinyPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.from([0, 0x2f, 0x6d, 0xb5]); // filter byte, then one pixel
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(row)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe.skipIf(!ON)("barako up against the published images", () => {
  let key = "";
  let failed = false;
  // Turns every secret in the stack folder into a mask before it is printed.
  const mask = (text: string) => {
    let out = text;
    for (const f of [".env", "api-key"]) {
      try {
        for (const line of readFileSync(join(stackDir, f), "utf8").split("\n")) {
          const v = line.includes("=") ? line.slice(line.indexOf("=") + 1).trim() : line.trim();
          if (v.length >= 8) out = out.split(v).join("***");
        }
      } catch {
        // No file yet.
      }
    }
    // Also a key that is in neither file any more, for example one replaced after core refused it.
    return out.replace(/bcms_[A-Za-z0-9_-]+/g, "bcms_***");
  };
  afterEach((ctx) => {
    if (ctx.task.result?.state === "fail") failed = true;
  });

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "barako-stack-int-"));
    stackDir = join(home, ".barako", "stack");
  });

  const printContainers = async () => {
    const boxes = await containers();
    console.log(`containers (service, state, restarts, started)\n${mask(boxes.map((b) => b.line).join("\n") || "none")}`);
    return boxes;
  };

  afterAll(async () => {
    // When a test failed, show what the services said before they are removed.
    if (failed) {
      for (const b of await printContainers()) {
        const r = await run("docker", ["logs", "--tail", "200", b.id], { DOCKER_CONFIG }, 60_000);
        console.log(`docker logs ${b.line.split(" ")[0]}\n${mask(r.stdout + r.stderr)}`);
      }
    }
    // Always remove the containers and the volume, also after a failure.
    await barako(["reset", "--yes"], 180_000);
    rmSync(home, { recursive: true, force: true });
  });

  it("up starts the stack and sets it up", async () => {
    const r = await barako(["up", "--port", String(PORT)], 15 * 60_000);
    expect(r.code, mask(r.stderr)).toBe(0);
    // Every time, so a restart count that grows before the next test shows in a passing run too.
    await printContainers();
    const out = JSON.parse(r.stdout).result;
    expect(out.alreadyRunning).toBe(false);
    expect(out.urls.site).toBe(`http://client.localhost:${PORT}`);
    key = readFileSync(join(stackDir, "api-key"), "utf8").trim();
    expect(key.length).toBeGreaterThan(16);
    expect(statSync(join(stackDir, "api-key")).mode & 0o777).toBe(0o600);
    expect(r.stdout).not.toContain(key);
    expect(r.stderr).not.toContain(key);
    expect(out.mcp).toContain("barako mcp");
  }, 16 * 60_000);

  // The test timeout is longer than the barako call, so a slow up fails with its own output.
  it("a second up changes nothing and keeps the key", async () => {
    const r = await barako(["up", "--port", String(PORT)], 120_000);
    expect(r.code, mask(r.stderr)).toBe(0);
    const out = JSON.parse(r.stdout).result;
    expect(out.alreadyRunning, mask(r.stderr)).toBe(true);
    expect(out.bootstrapped).toBe(false);
    expect(readFileSync(join(stackDir, "api-key"), "utf8").trim()).toBe(key);
  }, 150_000);

  it("health on the console and API hosts answers from core, with no redirect to https", async () => {
    for (const host of ["admin.localhost", "api.localhost"]) {
      const r = await curl(host, "/health");
      expect(r.status, `${host} /health`).toBe(200);
      expect(r.body, `${host} /health`).toContain("Healthy");
      expect(r.redirect, `${host} /health`).toBe("");
    }
  });

  it("the new key creates and publishes an entry through barako mcp", async () => {
    const title = `Stack check ${randomBytes(4).toString("hex")}`;
    const replies = await mcpSession(API, key, ["--allow-writes"], [
      () => toolCall(1, "plan_create_entry", { contentType: "post", data: { Title: title, Slug: `stack-check-${randomBytes(3).toString("hex")}`, Body: "Made by the stack check." }, publish: true }),
      applyOf("apply_plan", 2, 0),
    ]);
    expect(replies[0].result.isError, JSON.stringify(replies[0]).slice(0, 300)).toBe(false);
    expect(replies[1].result.isError, JSON.stringify(replies[1]).slice(0, 300)).toBe(false);
    expect(resultData(replies[1]).id).toBeTruthy();

    // Press caches pages, so give it time to pick the entry up.
    let page = { status: 0, redirect: "", body: "" };
    for (let i = 0; i < 45; i++) {
      page = await curl("client.localhost", "/");
      if (page.status === 200 && page.body.includes(title)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(page.status).toBe(200);
    expect(page.redirect).toBe("");
    expect(page.body).toContain(title);
  }, 180_000);

  // The kit's post type holds its cover as a url field, which core only takes absolute, so the entry
  // names the file by the address Caddy serves on the site's own origin.
  it("an uploaded image shows on the Press page from the same origin, under its CSP", async () => {
    const origin = `http://client.localhost:${PORT}`;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(tinyPng())], { type: "image/png" }), "stack-check.png");
    form.append("isPublic", "true");
    const up = await fetch(`${API}/api/files`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
    const upText = await up.text();
    expect(up.status, mask(upText).slice(0, 300)).toBe(201);
    const fileId = JSON.parse(upText).id as string;
    expect(fileId).toMatch(/^[0-9a-f-]{36}$/);
    const filePath = `/api/public/files/${fileId}`;

    const title = `Image check ${randomBytes(4).toString("hex")}`;
    const slug = `image-check-${randomBytes(3).toString("hex")}`;
    const replies = await mcpSession(API, key, ["--allow-writes"], [
      () => toolCall(1, "plan_create_entry", { contentType: "post", data: { Title: title, Slug: slug, Body: "Has a cover image.", CoverImage: `${origin}${filePath}`, CoverImageAlt: "stack check" }, publish: true }),
      applyOf("apply_plan", 2, 0),
    ]);
    expect(replies[0].result.isError, mask(JSON.stringify(replies[0])).slice(0, 300)).toBe(false);
    expect(replies[1].result.isError, mask(JSON.stringify(replies[1])).slice(0, 300)).toBe(false);

    // Press caches pages, so give it time to pick the entry up.
    let page = { status: 0, redirect: "", body: "" };
    for (let i = 0; i < 45; i++) {
      page = await curl("client.localhost", `/blog/${slug}`);
      if (page.status === 200 && page.body.includes(title)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(page.status).toBe(200);
    expect(page.body).toContain(title);

    // The image the page draws for this file: relative, or on the page's own origin.
    const srcs = [...page.body.matchAll(/<img\b[^>]*?\ssrc="([^"]*)"/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));
    const src = srcs.find((s) => s.includes(fileId));
    expect(src, `img srcs: ${srcs.join(", ")}`).toBeTruthy();
    const url = new URL(src!, `${origin}/`);
    expect(url.origin).toBe(origin);
    expect(url.pathname).toMatch(/^\/api\/public\/files\//);

    // The same host serves it as an image.
    const img = await headers("client.localhost", url.pathname + url.search);
    expect(img.status, img.head).toBe(200);
    expect(img.type).toMatch(/^image\//);
    expect(img.size).toBeGreaterThan(0);

    // The page's CSP, from the header or a meta tag, lets the same origin draw images.
    const doc = await headers("client.localhost", `/blog/${slug}`);
    const policies = [
      ...doc.head.split("\n").filter((l) => /^content-security-policy(-report-only)?:/i.test(l)).map((l) => l.slice(l.indexOf(":") + 1)),
      ...[...page.body.matchAll(/<meta[^>]*http-equiv="content-security-policy"[^>]*content="([^"]*)"/gi)].map((m) => m[1]!),
    ];
    for (const policy of policies) {
      const imgSrc = policy.split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src"));
      if (imgSrc) expect(imgSrc, "img-src").toContain("'self'");
    }
  }, 120_000);

  it("reset removes the volumes", async () => {
    const r = await barako(["reset", "--yes"], 180_000);
    expect(r.code, r.stderr).toBe(0);
    const volumes = await run("docker", ["volume", "ls", "-q", "--filter", "name=barako_pgdata"]);
    expect(volumes.stdout.trim()).toBe("");
    const boxes = await run("docker", ["ps", "-aq", "--filter", "label=com.docker.compose.project=barako"]);
    expect(boxes.stdout.trim()).toBe("");
  }, 200_000);
});
