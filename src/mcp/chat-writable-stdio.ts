#!/usr/bin/env node

import { createChicTripStdioTransport } from "./stdio-transport.js";
import { createAppContext } from "../app.js";
import { createChicTripMcpServer } from "./server.js";

const context = createAppContext();
const server = createChicTripMcpServer(context, { approvalMode: "chat-form" });
const transport = createChicTripStdioTransport();

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
