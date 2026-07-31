import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(import.meta.dir, "..");
const expectedTools = [
  "chictrip_capabilities",
  "chictrip_list_trips",
  "chictrip_get_trip",
  "chictrip_search_places",
  "chictrip_search_destinations",
  "chictrip_preview_trip_change",
  "chictrip_apply_trip_change",
  "chictrip_get_change_status",
];
const expectedEnabledWrites = [
  "createTrip",
  "updateTripFields",
  "addItem",
  "updateItem",
  "moveItem",
  "removeItem",
];
const temporaryStateDir = await mkdtemp(
  resolve(tmpdir(), "chictrip-chat-writable-smoke-"),
);

const transport = new StdioClientTransport({
  command: resolve(projectRoot, "scripts/run-chat-tunnel-mcp-writable.sh"),
  cwd: projectRoot,
  env: {
    ...getDefaultEnvironment(),
    // Deliberately try to disable writes. The explicit launcher must keep its
    // reviewed capability set stable.
    CHICTRIP_ENABLE_UNDOCUMENTED_WRITES: "0",
    CHICTRIP_ENABLE_EXPERIMENTAL_ITEM_ADDS: "0",
    CHICTRIP_STATE_DIR: temporaryStateDir,
  },
  stderr: "inherit",
});
const client = new Client(
  { name: "chictrip-chat-writable-smoke", version: "0.1.0" },
  { capabilities: { elicitation: { form: {} } } },
);

try {
  await client.connect(transport);

  const toolResponse = await client.listTools();
  const toolNames = toolResponse.tools.map((tool) => tool.name);
  if (JSON.stringify(toolNames) !== JSON.stringify(expectedTools)) {
    throw new Error(`Unexpected MCP tools: ${toolNames.join(", ")}`);
  }
  if (toolNames.some((name) => name.includes("approve"))) {
    throw new Error("Writable MCP must not expose a self-approval tool.");
  }

  const previewTool = toolResponse.tools.find(
    (tool) => tool.name === "chictrip_preview_trip_change",
  );
  const previewSchema = previewTool?.inputSchema as
    | {
        required?: string[];
        properties?: { intent?: { oneOf?: unknown[] } };
      }
    | undefined;
  if (
    JSON.stringify(previewSchema?.required) !== JSON.stringify(["intent"]) ||
    previewSchema?.properties?.intent?.oneOf?.length !== 2
  ) {
    throw new Error(
      "Writable preview tool did not publish create/update intent schemas.",
    );
  }

  const applyTool = toolResponse.tools.find(
    (tool) => tool.name === "chictrip_apply_trip_change",
  );
  if (
    applyTool?.title !== "Confirm and apply a chicTrip change" ||
    !applyTool.description?.includes("form elicitation") ||
    applyTool.annotations?.readOnlyHint !== false ||
    applyTool.annotations.destructiveHint !== true ||
    applyTool.annotations.idempotentHint !== true
  ) {
    throw new Error(
      "Writable apply tool is missing its Chat confirmation contract.",
    );
  }

  const response = await client.callTool({
    name: "chictrip_capabilities",
    arguments: {},
  });
  const structured = response.structuredContent as
    | {
        ok?: boolean;
        data?: {
          authenticated?: boolean;
          write?: Record<string, unknown>;
        };
      }
    | undefined;
  const writes = structured?.data?.write;
  const enabledWrites = Object.entries(writes ?? {})
    .filter(([key, value]) => key !== "requiresApproval" && value === true)
    .map(([key]) => key);

  if (
    structured?.ok !== true ||
    !writes ||
    JSON.stringify(enabledWrites) !== JSON.stringify(expectedEnabledWrites) ||
    writes.deleteTrip !== false ||
    writes.requiresApproval !== true
  ) {
    throw new Error(
      `Writable Chat tunnel capabilities are incorrect (isError=${response.isError === true}, enabled=${enabledWrites.join(", ")}, result=${JSON.stringify(structured)}).`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      toolCount: toolNames.length,
      authenticated: structured.data?.authenticated === true,
      writesEnabled: true,
      enabledWrites,
      requiresChatConfirmation: true,
    })}\n`,
  );
} finally {
  await client.close();
  await rm(temporaryStateDir, { recursive: true, force: true });
}
