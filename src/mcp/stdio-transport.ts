import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Explicitly bounded, while allowing large multilingual itineraries that exceed
// the SDK's 10 MiB default. This is a byte budget, not a process memory ceiling.
export const STDIO_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export function createChicTripStdioTransport(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): StdioServerTransport {
  return new StdioServerTransport(input, output, {
    maxBufferSize: STDIO_MAX_BUFFER_BYTES,
  });
}
