import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { AppContext } from "../src/app.js";
import { AppError } from "../src/domain/errors.js";
import { createChicTripMcpServer } from "../src/mcp/server.js";

const INTENT_HASH = "intent-hash-123456";
const REVIEW_CODE = "A1B2C3D4";
const EXPECTED_CONFIRMATION = `APPLY ${REVIEW_CODE}`;

type ElicitationCapability =
  | undefined
  | Record<string, never>
  | { form: Record<string, never> }
  | { url: Record<string, never> };

function createFixture(options: { freshLocalGrant?: boolean } = {}) {
  const previewId = randomUUID();
  const idempotencyKey = randomUUID();
  const operationId = randomUUID();
  const stats = {
    approveCalls: 0,
    applyCalls: 0,
    approval: undefined as
      | { previewId: string; typedConfirmation: string }
      | undefined,
  };
  const context = {
    store: {
      read: async () => ({
        schemaVersion: 1,
        previews: {
          [previewId]: {
            preview: {
              previewId,
              intentHash: INTENT_HASH,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              diff: [{ path: "/title", action: "update" }],
              blockers: [],
              warnings: [
                {
                  code: "UNDOCUMENTED_PROVIDER_API",
                  message: "Review carefully.",
                },
              ],
              estimatedProviderWrites: 1,
              approval: { reviewCode: REVIEW_CODE },
            },
            intent: {
              kind: "update",
              tripId: "trip-1",
              baseRevision: {
                contentHash: "content-hash",
                readAt: new Date().toISOString(),
              },
              operations: [],
            },
            desired: {
              title: "Test trip",
              startDate: "2026-10-01",
              endDate: "2026-10-03",
            },
            ...(options.freshLocalGrant
              ? {
                  approvalGrant: {
                    token: "existing-local-grant",
                    issuedAt: new Date().toISOString(),
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                  },
                }
              : {}),
          },
        },
        usedApprovalNonces: {},
        ledger: {},
      }),
    },
    service: {
      approve: async (id: string, typedConfirmation: string) => {
        stats.approveCalls += 1;
        stats.approval = { previewId: id, typedConfirmation };
        if (typedConfirmation !== EXPECTED_CONFIRMATION) {
          throw new AppError(
            "APPROVAL_INVALID",
            "The typed confirmation did not match the review code.",
          );
        }
        return {
          previewId: id,
          intentHash: INTENT_HASH,
          approvedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      apply: async () => {
        stats.applyCalls += 1;
        return {
          operationId,
          status: "applied" as const,
          tripId: "trip-1",
          reconciliation: {
            state: "verified" as const,
            message: "verified",
          },
        };
      },
    },
  } as unknown as AppContext;

  return { context, previewId, idempotencyKey, stats };
}

async function invokeApply(
  fixture: ReturnType<typeof createFixture>,
  elicitation: ElicitationCapability,
  onElicit?: (request: ElicitRequest) => ElicitResult | Promise<ElicitResult>,
) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createChicTripMcpServer(fixture.context, {
    approvalMode: "chat-form",
  });
  const client = new Client(
    { name: "host-approval-test", version: "0.1.0" },
    {
      capabilities:
        elicitation === undefined ? {} : { elicitation: elicitation },
    },
  );
  if (onElicit) {
    client.setRequestHandler(ElicitRequestSchema, onElicit);
  }

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const tools = await client.listTools();
    const response = await client.callTool({
      name: "chictrip_apply_trip_change",
      arguments: {
        previewId: fixture.previewId,
        intentHash: INTENT_HASH,
        idempotencyKey: fixture.idempotencyKey,
      },
    });
    return { response, tools };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP Chat form approval mode", () => {
  test("elicits the exact review code before creating a local grant", async () => {
    const fixture = createFixture();
    let elicitationMessage: string | undefined;
    const { response, tools } = await invokeApply(
      fixture,
      { form: {} },
      async (request) => {
        if (request.params.mode === "url") {
          throw new Error("Expected form elicitation.");
        }
        elicitationMessage = request.params.message;
        expect(request.params.requestedSchema.required).toEqual([
          "confirmation",
        ]);
        return {
          action: "accept",
          content: { confirmation: EXPECTED_CONFIRMATION },
        };
      },
    );

    const applyTool = tools.tools.find(
      (tool) => tool.name === "chictrip_apply_trip_change",
    );
    expect(applyTool?.title).toBe("Confirm and apply a chicTrip change");
    expect(applyTool?.annotations?.destructiveHint).toBe(true);
    expect(applyTool?.description).toContain("elicitation");
    expect(response.isError).not.toBe(true);
    expect(elicitationMessage).toContain(fixture.previewId);
    expect(elicitationMessage).toContain('"tripId": "trip-1"');
    expect(elicitationMessage).toContain('"path": "/title"');
    expect(elicitationMessage).toContain('"action": "update"');
    expect(elicitationMessage).toContain(
      '"code": "UNDOCUMENTED_PROVIDER_API"',
    );
    expect(elicitationMessage).toContain(EXPECTED_CONFIRMATION);
    expect(fixture.stats.approval).toEqual({
      previewId: fixture.previewId,
      typedConfirmation: EXPECTED_CONFIRMATION,
    });
    expect(fixture.stats.applyCalls).toBe(1);
  });

  test("accepts the SDK-compatible empty elicitation capability", async () => {
    const fixture = createFixture();
    const { response } = await invokeApply(fixture, {}, async () => ({
      action: "accept",
      content: { confirmation: EXPECTED_CONFIRMATION },
    }));

    expect(response.isError).not.toBe(true);
    expect(fixture.stats.approveCalls).toBe(1);
    expect(fixture.stats.applyCalls).toBe(1);
  });

  test("rejects absent and URL-only elicitation capabilities", async () => {
    for (const capability of [undefined, { url: {} }] as const) {
      const fixture = createFixture();
      const { response } = await invokeApply(fixture, capability);

      expect(response.isError).toBe(true);
      expect(response.structuredContent).toMatchObject({
        ok: false,
        error: { code: "APPROVAL_REQUIRED" },
      });
      expect(fixture.stats.approveCalls).toBe(0);
      expect(fixture.stats.applyCalls).toBe(0);
    }
  });

  test("a fresh local grant cannot bypass the Chat form capability", async () => {
    const fixture = createFixture({ freshLocalGrant: true });
    const { response } = await invokeApply(fixture, undefined);

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      ok: false,
      error: { code: "APPROVAL_REQUIRED" },
    });
    expect(fixture.stats.approveCalls).toBe(0);
    expect(fixture.stats.applyCalls).toBe(0);

    const confirmedFixture = createFixture({ freshLocalGrant: true });
    const confirmed = await invokeApply(
      confirmedFixture,
      { form: {} },
      async () => ({
        action: "accept",
        content: { confirmation: EXPECTED_CONFIRMATION },
      }),
    );
    expect(confirmed.response.isError).not.toBe(true);
    expect(confirmedFixture.stats.approveCalls).toBe(1);
    expect(confirmedFixture.stats.applyCalls).toBe(1);
  });

  test("decline and cancel create no grant and perform no write", async () => {
    for (const action of ["decline", "cancel"] as const) {
      const fixture = createFixture();
      const { response } = await invokeApply(fixture, { form: {} }, async () => ({
        action,
      }));

      expect(response.isError).toBe(true);
      expect(response.structuredContent).toMatchObject({
        ok: false,
        error: { code: "APPROVAL_REQUIRED" },
      });
      expect(fixture.stats.approveCalls).toBe(0);
      expect(fixture.stats.applyCalls).toBe(0);
    }
  });

  test("a wrong review code cannot reach apply", async () => {
    const fixture = createFixture();
    const { response } = await invokeApply(fixture, { form: {} }, async () => ({
      action: "accept",
      content: { confirmation: "APPLY Z9Y8X7W6" },
    }));

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      ok: false,
      error: { code: "APPROVAL_INVALID" },
    });
    expect(fixture.stats.approveCalls).toBe(1);
    expect(fixture.stats.applyCalls).toBe(0);
  });
});
