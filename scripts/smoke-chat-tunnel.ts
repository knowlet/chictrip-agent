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
const temporaryStateDir = await mkdtemp(
  resolve(tmpdir(), "chictrip-chat-tunnel-smoke-"),
);

const transport = new StdioClientTransport({
  command: resolve(projectRoot, "scripts/run-chat-tunnel-mcp.sh"),
  cwd: projectRoot,
  env: {
    ...getDefaultEnvironment(),
    // Deliberately try to enable writes. The launcher must override both flags.
    CHICTRIP_ENABLE_UNDOCUMENTED_WRITES: "1",
    CHICTRIP_ENABLE_EXPERIMENTAL_ITEM_ADDS: "1",
    CHICTRIP_STATE_DIR: temporaryStateDir,
  },
  stderr: "inherit",
});
const client = new Client(
  { name: "chictrip-chat-tunnel-smoke", version: "0.1.0" },
  { capabilities: {} },
);

try {
  await client.connect(transport);

  const toolResponse = await client.listTools();
  const toolNames = toolResponse.tools.map((tool) => tool.name);
  if (JSON.stringify(toolNames) !== JSON.stringify(expectedTools)) {
    throw new Error(`Unexpected MCP tools: ${toolNames.join(", ")}`);
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

  if (structured?.ok !== true || !writes || enabledWrites.length > 0) {
    throw new Error(
      `Chat tunnel launcher capabilities failed or are not read-only (isError=${response.isError === true}, enabled=${enabledWrites.join(", ")}).`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      toolCount: toolNames.length,
      authenticated: structured.data?.authenticated === true,
      writesEnabled: false,
    })}\n`,
  );
} finally {
  await client.close();
  await rm(temporaryStateDir, { recursive: true, force: true });
}
