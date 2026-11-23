#!/usr/bin/env node

import { createChicTripStdioTransport } from "./stdio-transport.js";
import { createChicTripMcpServer } from "./server.js";

const server = createChicTripMcpServer();
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
