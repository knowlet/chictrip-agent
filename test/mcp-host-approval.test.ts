import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AppContext } from "../src/app.js";
import { createChicTripMcpServer } from "../src/mcp/server.js";

describe("MCP host approval mode", () => {
  test("turns one approved apply tool call into a short-lived local grant", async () => {
    const previewId = randomUUID();
    const idempotencyKey = randomUUID();
    const operationId = randomUUID();
    const intentHash = "intent-hash";
    let approval:
      | { previewId: string; typedConfirmation: string }
      | undefined;

    const context = {
      store: {
        read: async () => ({
          schemaVersion: 1,
          previews: {
            [previewId]: {
              preview: {
                previewId,
                intentHash,
                approval: { reviewCode: "A1B2C3D4" },
              },
            },
          },
          usedApprovalNonces: {},
          ledger: {},
        }),
      },
      service: {
        approve: async (id: string, typedConfirmation: string) => {
          approval = { previewId: id, typedConfirmation };
          return {
            previewId: id,
            intentHash,
            approvedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        },
        apply: async () => ({
          operationId,
          status: "applied" as const,
          tripId: "trip-1",
          reconciliation: {
            state: "verified" as const,
            message: "verified",
          },
        }),
      },
    } as unknown as AppContext;

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createChicTripMcpServer(context, {
      approvalMode: "host-ui",
    });
    const client = new Client(
      { name: "host-approval-test", version: "0.1.0" },
      { capabilities: {} },
    );

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const tools = await client.listTools();
      const applyTool = tools.tools.find(
        (tool) => tool.name === "chictrip_apply_trip_change",
      );
      expect(applyTool?.title).toBe("Approve and apply a chicTrip change");
      expect(applyTool?.annotations?.destructiveHint).toBe(true);
      expect(applyTool?.description).toContain("single approval");

      const response = await client.callTool({
        name: "chictrip_apply_trip_change",
        arguments: { previewId, intentHash, idempotencyKey },
      });

      expect(response.isError).not.toBe(true);
      expect(approval).toEqual({
        previewId,
        typedConfirmation: "APPLY A1B2C3D4",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
