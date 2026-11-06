import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
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
