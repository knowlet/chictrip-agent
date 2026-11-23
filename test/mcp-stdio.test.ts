import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReadBuffer } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { TripChangeIntentSchema } from "../src/domain/schemas.js";
import { createChicTripStdioTransport, STDIO_MAX_BUFFER_BYTES } from "../src/mcp/stdio-transport.js";

async function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = createChicTripStdioTransport(input, output);
  const messages: JSONRPCMessage[] = [];
  const errors: Error[] = [];
  let closed = false;
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error);
  transport.onclose = () => { closed = true; };
  await transport.start();
  return { input, messages, errors, isClosed: () => closed,
    close: async () => { await transport.close(); input.destroy(); output.destroy(); } };
}

function countElements(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  const children = Object.values(value);
  return children.length + children.reduce<number>((sum, child) => sum + countElements(child), 0);
}

describe("bounded stdio transport", () => {
  test("accepts a large schema-valid multilingual itinerary within both budgets", async () => {
    const intent = {
      kind: "create",
      desired: {
        title: "大型行程", startDate: "2026-01-01", endDate: "2026-03-01",
        timezone: "Asia/Taipei", trafficType: "Walking",
        destinations: Array.from({ length: 20 }, () => ({ providerLocationKey: "x", name: "x" })),
        days: Array.from({ length: 60 }, (_, index) => ({
          date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
          items: Array.from({ length: 80 }, () => ({
            id: "x", place: { providerPlaceId: "x", name: "x", latitude: 0, longitude: 0, coverMediaId: "x" },
            startsAt: "2026-01-01T00:00:00Z", durationMinutes: 1,
            note: "旅".repeat(2_000), categoryId: "x",
          })),
        })),
      },
    };
    expect(TripChangeIntentSchema.safeParse(intent).success).toBe(true);
    expect(countElements({ intent })).toBeLessThan(100_000);
    const request: JSONRPCMessage = { jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "chictrip_preview_trip_change", arguments: { intent } } };
    const bytes = Buffer.from(JSON.stringify(request) + "\n");
    expect(bytes.length).toBeGreaterThan(10 * 1024 * 1024);
    expect(bytes.length).toBeLessThan(STDIO_MAX_BUFFER_BYTES);
    const h = await harness();
    try {
      // Fragment the input across UTF-8 code points, as an actual pipe may do.
      const split = bytes.indexOf(Buffer.from("旅")) + 1;
      h.input.write(bytes.subarray(0, split));
      h.input.write(bytes.subarray(split));
      expect(h.errors).toEqual([]);
      expect(h.messages).toHaveLength(1);
      expect(h.messages[0]).toEqual(request);
      expect(h.isClosed()).toBe(false);
    } finally { await h.close(); }
  }, 30_000);

  test("accepts exactly 64 MiB including the newline", async () => {
    const h = await harness();
    try {
      const json = Buffer.from('{"jsonrpc":"2.0","method":"ping"}');
      const bytes = Buffer.alloc(STDIO_MAX_BUFFER_BYTES, 32);
      json.copy(bytes);
      bytes[bytes.length - 1] = 10;
      h.input.write(bytes);
      expect(h.errors).toEqual([]);
      expect(h.messages).toEqual([{ jsonrpc: "2.0", method: "ping" }]);
      expect(h.isClosed()).toBe(false);
    } finally { await h.close(); }
  }, 30_000);

  test("closes before parsing when fragmented input exceeds 64 MiB", async () => {
    const h = await harness();
    try {
      h.input.write(Buffer.alloc(STDIO_MAX_BUFFER_BYTES, 32));
      expect(h.isClosed()).toBe(false);
      h.input.write(Buffer.from("\n"));
      expect(h.isClosed()).toBe(true);
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]?.message).toContain("exceeded maximum size of 67108864 bytes");
      expect(h.messages).toHaveLength(0);
      expect(h.input.listenerCount("data")).toBe(0);
    } finally { await h.close(); }
  }, 30_000);

  test("accepts a valid message when the same chunk starts the next one", async () => {
    const h = await harness();
    try {
      const first = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
      const nextStart = Buffer.alloc(STDIO_MAX_BUFFER_BYTES, 32);
      const chunk = Buffer.concat([first, nextStart]);
      expect(chunk.length).toBeGreaterThan(STDIO_MAX_BUFFER_BYTES);
      h.input.write(chunk);
      expect(h.errors).toEqual([]);
      expect(h.isClosed()).toBe(false);
      expect(h.messages).toEqual([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    } finally { await h.close(); }
  }, 30_000);

  test("reads one 64 MiB message assembled from small fragments", () => {
    const buffer = new ReadBuffer({ maxBufferSize: STDIO_MAX_BUFFER_BYTES });
    const bytes = Buffer.alloc(STDIO_MAX_BUFFER_BYTES, 32);
    const json = Buffer.from('{"jsonrpc":"2.0","method":"ping"}');
    json.copy(bytes);
    bytes[bytes.length - 1] = 10;
    const started = performance.now();
    const fragment = 16 * 1024;
    for (let offset = 0; offset < bytes.length; offset += fragment) {
      buffer.append(bytes.subarray(offset, offset + fragment));
    }
    const message = buffer.readMessage();
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(message).toEqual({ jsonrpc: "2.0", method: "ping" });
    expect(buffer.readMessage()).toBeNull();
  }, 30_000);

  test("keeps a split message when the completing chunk also has an oversized line", () => {
    const limit = 128;
    const buffer = new ReadBuffer({ maxBufferSize: limit });
    const message = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    expect(message.length).toBeLessThan(limit);
    const split = Math.floor(message.length / 2);
    buffer.append(message.subarray(0, split));
    const oversized = Buffer.alloc(limit + 1, 32);
    oversized[oversized.length - 1] = 10;
    let caught: unknown;
    try {
      buffer.append(Buffer.concat([message.subarray(split), oversized]));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(`exceeded maximum size of ${limit} bytes`);
    expect(buffer.readMessage()).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(buffer.readMessage()).toBeNull();
  });

  test("drains 128k fragments under Node with one splice", async () => {
    const script = `
      import { ReadBuffer } from "@modelcontextprotocol/sdk/shared/stdio.js";
      const count = 128000;
      const buffer = new ReadBuffer({ maxBufferSize: count + 64 });
      const head = Buffer.from('{"jsonrpc":"2.0","method":"ping"}');
      buffer.append(head);
      const space = Buffer.from(" ");
      for (let index = 0; index < count; index++) buffer.append(space);
      buffer.append(Buffer.from("\\n"));
      const started = performance.now();
      const message = buffer.readMessage();
      const elapsed = performance.now() - started;
      if (!message || message.method !== "ping") process.exit(2);
      if (elapsed >= 1000) {
        console.error(elapsed.toFixed(1));
        process.exit(3);
      }
      console.log(elapsed.toFixed(1));
    `;
    const child = Bun.spawn(["node", "--input-type=module", "-e", script], {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr, stdout: stdout.trim() }).toMatchObject({ exitCode: 0 });
    expect(Number(stdout.trim())).toBeLessThan(1_000);
  }, 20_000);

  test("keeps valid messages when the same chunk contains an oversized line", () => {
    const limit = 128;
    const buffer = new ReadBuffer({ maxBufferSize: limit });
    const valid = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    expect(valid.length).toBeLessThan(limit);
    const oversized = Buffer.alloc(limit + 1, 32);
    oversized[oversized.length - 1] = 10;
    const after = Buffer.from('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
    let caught: unknown;
    try {
      buffer.append(Buffer.concat([valid, oversized, after]));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(`exceeded maximum size of ${limit} bytes`);
    expect(buffer.readMessage()).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(buffer.readMessage()).toEqual({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect(buffer.readMessage()).toBeNull();
  });

  test("delivers a valid message when the same chunk ends with an oversized line", async () => {
    const h = await harness();
    try {
      const first = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
      const oversized = Buffer.alloc(STDIO_MAX_BUFFER_BYTES + 1, 32);
      oversized[oversized.length - 1] = 10;
      const second = Buffer.from('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
      h.input.write(Buffer.concat([first, oversized, second]));
      expect(h.messages).toEqual([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ]);
      expect(h.isClosed()).toBe(true);
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]?.message).toContain("exceeded maximum size of 67108864 bytes");
      expect(h.input.listenerCount("data")).toBe(0);
    } finally { await h.close(); }
  }, 30_000);

  test("closes on one line longer than 64 MiB", async () => {
    const h = await harness();
    try {
      const line = Buffer.alloc(STDIO_MAX_BUFFER_BYTES + 1, 32);
      line[line.length - 1] = 10;
      h.input.write(line);
      expect(h.isClosed()).toBe(true);
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]?.message).toContain("exceeded maximum size of 67108864 bytes");
      expect(h.messages).toHaveLength(0);
      expect(h.input.listenerCount("data")).toBe(0);
    } finally { await h.close(); }
  }, 30_000);

  test("packs tiny unfinished fragments into fixed blocks", () => {
    const buffer = new ReadBuffer({ maxBufferSize: 200_000 });
    const piece = Buffer.from("x");
    const count = 100_000;
    for (let index = 0; index < count; index++) buffer.append(piece);
    const stored = (buffer as unknown as { _chunks: Buffer[] })._chunks;
    expect(stored.length).toBeLessThan(count / 1000);
    expect(stored.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(count);
  });

  test("replies to a tool call that shares a chunk with an oversized line", async () => {
    const calls: string[] = [];
    const input = new PassThrough();
    const output = new PassThrough();
    const server = new McpServer({ name: "stub", version: "0.0.0" });
    server.registerTool(
      "stub_echo",
      {
        description: "Echo one string.",
        inputSchema: { text: z.string() },
      },
      async ({ text }) => {
        calls.push(text);
        await Promise.resolve();
        return { content: [{ type: "text", text }] };
      },
    );
    const transport = new StdioServerTransport(input, output, { maxBufferSize: 4_096 });
    const stdout: string[] = [];
    output.on("data", (chunk) => stdout.push(chunk.toString("utf8")));
    await server.connect(transport);
    const write = (message: unknown) => {
      input.write(`${JSON.stringify(message)}\n`);
    };
    const waitFor = (id: number) => new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`no reply for id ${id}`)), 2_000);
      const onData = () => {
        if (stdout.join("").includes(`"id":${id}`)) {
          clearTimeout(timeout);
          output.off("data", onData);
          resolve();
        }
      };
      output.on("data", onData);
      onData();
    });
    try {
      write({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      });
      await waitFor(1);
      write({ jsonrpc: "2.0", method: "notifications/initialized" });
      const call = {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "stub_echo", arguments: { text: "kept" } },
      };
      const callBytes = Buffer.from(`${JSON.stringify(call)}\n`);
      expect(callBytes.length).toBeLessThan(4_096);
      const oversized = Buffer.alloc(4_097, 32);
      oversized[oversized.length - 1] = 10;
      input.write(Buffer.concat([callBytes, oversized]));
      await waitFor(2);
      expect(calls).toEqual(["kept"]);
      expect(stdout.join("")).toContain("kept");
      input.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "stub_echo", arguments: { text: "late" } },
      })}\n`);
      await new Promise((resolve) => setImmediate(resolve));
      expect(calls).toEqual(["kept"]);
    } finally {
      await server.close();
    }
  });

  test("continues parsing consecutive small messages", async () => {
    const h = await harness();
    try {
      const line = '{"jsonrpc":"2.0","method":"ping"}\n';
      h.input.write(line + line);
      h.input.write(line);
      expect(h.messages).toHaveLength(3);
      expect(h.errors).toEqual([]);
      expect(h.isClosed()).toBe(false);
    } finally { await h.close(); }
  });
});
