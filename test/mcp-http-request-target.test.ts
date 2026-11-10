import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const token = "synthetic-http-test-token-at-least-32-characters";
let child: ChildProcess | undefined;
let fixture: string | undefined;
let exited: Promise<void> | undefined;
let port: number;

beforeAll(async () => {
  const projectRoot = resolve(import.meta.dir, "..");
  // Exercise Node's real HTTP parser and the actual bundled handler. Keep the
  // fixture under the project so external playwright-core resolves normally.
  fixture = await mkdtemp(join(projectRoot, ".http-test-"));
  const bundle = join(fixture, "http.mjs");
  const builder = Bun.spawn([
    process.execPath, "build", join(projectRoot, "src/mcp/http.ts"),
    "--target=node", "--external=playwright-core", `--outfile=${bundle}`,
  ], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
  const [buildStatus, buildError] = await Promise.all([
    builder.exited, new Response(builder.stderr).text(),
  ]);
  if (buildStatus !== 0) throw new Error(buildError);
  const script = `
    import { createMcpHttpServer } from ${JSON.stringify(pathToFileURL(bundle).href)};
    const server = createMcpHttpServer(${JSON.stringify(token)});
    server.listen(0, "127.0.0.1", () => console.log(server.address().port));
  `;
  child = spawn("node", ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  exited = new Promise<void>((resolve) => child!.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child!.once("error", reject);
    child!.stderr!.on("data", (chunk) => { stderr += String(chunk); });
    child!.once("exit", (code) => reject(new Error(`Node HTTP fixture exited ${code}: ${stderr}`)));
    child!.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes("\n")) {
        port = Number(stdout.trim());
        if (Number.isInteger(port) && port > 0) resolve();
        else reject(new Error("Node HTTP fixture did not report a port"));
      }
    });
  });
});

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await exited;
  }
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

function send(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, string> }>((resolve, reject) => {
    // A raw socket preserves malformed request-target bytes instead of letting
    // the client URL parser reject or normalize them before they reach Node.
    const socket = connect(port, "127.0.0.1", () => {
      const lines = Object.entries({ host: "localhost", connection: "close", ...headers })
        .map(([name, value]) => `${name}: ${value}`);
      socket.write(`GET ${path} HTTP/1.0\r\n${lines.join("\r\n")}\r\n\r\n`);
    });
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { raw += chunk; });
    socket.once("error", reject);
    socket.setTimeout(2_000, () => socket.destroy(new Error("HTTP test timed out")));
    socket.once("end", () => {
      const split = raw.indexOf("\r\n\r\n");
      const status = /^HTTP\/1\.[01] (\d+)/.exec(raw)?.[1];
      if (split < 0 || !status) return reject(new Error("Node closed without an HTTP response"));
      const headers = Object.fromEntries(raw.slice(0, split).split("\r\n").slice(1).map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
      }));
      resolve({ status: Number(status), body: raw.slice(split + 4), headers });
    });
  });
}

describe("MCP HTTP request-target parsing", () => {
  for (const target of ["//[", "http://[", "//localhost:bad/mcp", "http://localhost:65536/mcp"]) {
    test(`rejects malformed target ${target} and keeps serving`, async () => {
      const response = await send(target);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid request target." },
        id: null,
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect((await send("/mcp")).status).toBe(401);
    });
  }

  test("preserves valid paths, query strings and HTTP access guards", async () => {
    expect((await send("/not-found")).status).toBe(404);
    expect((await send("/mcp?key=value")).status).toBe(401);
    expect((await send("http://localhost/mcp")).status).toBe(401);
    expect((await send("/mcp", { authorization: `Bearer ${token}` })).status).toBe(405);
    expect((await send("/mcp", { origin: "https://example.invalid" })).status).toBe(403);
    expect((await send("//[", { host: "example.invalid" })).status).toBe(403);
  });
});
