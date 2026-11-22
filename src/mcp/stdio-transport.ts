import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Per newline-delimited message, including that message's terminating newline,
// not per read() chunk. A chunk may finish one in-limit message and begin the
// next. An oversized single line closes the transport. This stays above the
// SDK's 10 MiB default so large multilingual itineraries fit, and it is a byte
// budget, not a process memory ceiling.
export const STDIO_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export function createChicTripStdioTransport(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): StdioServerTransport {
  return new StdioServerTransport(input, output, {
    maxBufferSize: STDIO_MAX_BUFFER_BYTES,
  });
}
