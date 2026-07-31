#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAppContext } from "../app.js";
import { createChicTripMcpServer } from "./server.js";

const context = createAppContext();
const server = createChicTripMcpServer(context, { approvalMode: "host-ui" });
const transport = new StdioServerTransport();

await server.connect(transport);

async function shutdown(): Promise<void> {
  await server.close();
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
