import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAppContext } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { ChicTripTransport } from "../src/domain/types.js";
import { AppError } from "../src/domain/errors.js";
import {
  createChicTripMcpServer,
  publicMcpError,
  redactMcpOutput,
} from "../src/mcp/server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function context() {
  const stateDir = await mkdtemp(join(tmpdir(), "chictrip-mcp-test-"));
  temporaryDirectories.push(stateDir);
  const config: AppConfig = {
    stateDir,
    browserProfileDir: join(stateDir, "browser"),
    browserChannel: "chrome",
    enableUndocumentedWrites: false,
    enableExperimentalItemAdds: false,
    previewTtlMs: 15 * 60_000,
    approvalTtlMs: 5 * 60_000,
    apiBaseUrl: "https://api.chictrip.com.tw/",
    providerClientVersion: "2.0.38",
    siteUrl: "https://www.chictrip.com.tw/landing",
    httpHost: "127.0.0.1",
    httpPort: 3333,
  };
  const unsupported = async (): Promise<never> => {
    throw new Error("not used by the MCP metadata test");
  };
  const transport: ChicTripTransport = {
    kind: "browser",
    getCapabilities: async () => ({
      transport: "browser",
      supportLevel: "experimental-undocumented",
      authenticated: false,
      read: {
        listTrips: true,
        getTrip: true,
        searchPlaces: true,
        searchDestinations: true,
      },
      write: {
        createTrip: false,
        updateTripFields: false,
        addItem: false,
        updateItem: false,
        moveItem: false,
        removeItem: false,
        deleteTrip: false,
        requiresApproval: true,
        idempotency: "local-ledger",
        atomicity: "multi-step",
      },
      caveats: [],
    }),
    listTrips: unsupported,
    getTrip: unsupported,
    searchPlaces: unsupported,
    searchDestinations: unsupported,
    createTrip: unsupported,
    updateTrip: unsupported,
  };
  return createAppContext({ config, transport });
}

describe("MCP tool contract", () => {
  test("exposes guarded itinerary tools without an approval tool", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createChicTripMcpServer(await context());
    const client = new Client(
      { name: "chictrip-agent-test", version: "0.1.0" },
      { capabilities: {} },
    );
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const response = await client.listTools();
      const names = response.tools.map((tool) => tool.name);
      expect(names).toEqual([
        "chictrip_capabilities",
        "chictrip_list_trips",
        "chictrip_get_trip",
        "chictrip_search_places",
        "chictrip_search_destinations",
        "chictrip_preview_trip_change",
        "chictrip_apply_trip_change",
        "chictrip_get_change_status",
      ]);
      expect(names.some((name) => name.includes("approve"))).toBe(false);

      const preview = response.tools.find(
        (tool) => tool.name === "chictrip_preview_trip_change",
      );
      expect(preview?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });

      const list = response.tools.find(
        (tool) => tool.name === "chictrip_list_trips",
      );
      expect(list?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });

      const apply = response.tools.find(
        (tool) => tool.name === "chictrip_apply_trip_change",
      );
      expect(apply?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(
        (apply?.inputSchema as { required?: string[] }).required,
      ).toEqual(["previewId", "intentHash", "idempotencyKey"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("uses fixed public errors and removes credential-shaped output", () => {
    const providerError = publicMcpError(
      new AppError(
        "PROVIDER_ERROR",
        "Bearer top-secret-provider-diagnostic should never be returned.",
      ),
    );
    expect(providerError).toEqual({
      code: "PROVIDER_ERROR",
      message:
        "chicTrip returned an error and no provider diagnostics were exposed.",
      retryable: false,
    });

    const redacted = redactMcpOutput({
      authorizationHeader: "Bearer secret",
      nested: {
        refresh_token_value: "secret",
        note:
          "Bearer abcdefghijklmnopqrstuvwxyz012345 and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signaturevalue",
        capability: `${"a".repeat(40)}.${"b".repeat(32)}`,
        url: "https://example.invalid/?access_token=secret-value&ok=1",
      },
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("authorizationHeader");
    expect(serialized).not.toContain("refresh_token_value");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(serialized).not.toContain("eyJhbGci");
    expect(serialized).not.toContain("a".repeat(40));
    expect(serialized).not.toContain("secret-value");
    expect(serialized).toContain("[REDACTED");
  });
});
