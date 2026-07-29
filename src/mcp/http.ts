#!/usr/bin/env node

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { StreamableHTTPServerTransportOptions } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadConfig } from "../config.js";
import { createChicTripMcpServer } from "./server.js";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
const maximumBodyBytes = 1_048_576;
const minimumBearerLength = 32;

export interface HttpBearerCredential {
  token: string;
  generated: boolean;
}

export function resolveHttpBearerCredential(
  configuredToken: string | undefined,
): HttpBearerCredential {
  if (configuredToken !== undefined) {
    if (
      configuredToken.length < minimumBearerLength ||
      configuredToken.length > 4_096 ||
      /[\u0000-\u0020\u007f]/.test(configuredToken)
    ) {
      throw new Error(
        "CHICTRIP_MCP_BEARER_TOKEN must be 32-4096 non-whitespace characters.",
      );
    }
    return { token: configuredToken, generated: false };
  }
  return {
    token: randomBytes(32).toString("base64url"),
    generated: true,
  };
}

export function isAuthorizedBearer(
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean {
  if (!authorizationHeader?.startsWith("Bearer ")) return false;
  const suppliedToken = authorizationHeader.slice("Bearer ".length);
  if (!suppliedToken || suppliedToken.includes(" ")) return false;
  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" ||
    Boolean(mediaType && /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType))
  );
}

export function hasDisallowedOrigin(origin: string | undefined): boolean {
  return origin !== undefined;
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function allowedHostHeader(header: string | undefined): boolean {
  if (!header) return false;
  const host = header.toLowerCase().replace(/:\d+$/, "");
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBodyBytes) {
      throw new RequestBodyError(413, "Request body is too large.");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new RequestBodyError(400, "Request body is not valid JSON.");
  }
}

async function handleMcpPost(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const server = createChicTripMcpServer();
  // SDK 1.29 documents `undefined` as stateless mode, while its declaration
  // omits explicit undefined under exactOptionalPropertyTypes.
  const statelessOptions = {
    sessionIdGenerator: undefined,
  } as unknown as StreamableHTTPServerTransportOptions;
  const transport = new StreamableHTTPServerTransport(statelessOptions);
  response.once("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    const body = await readJsonBody(request);
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(request, response, body);
  } catch (error) {
    if (!response.headersSent) {
      const status = error instanceof RequestBodyError ? error.status : 500;
      writeJson(response, status, {
        jsonrpc: "2.0",
        error: {
          code: status === 400 ? -32700 : -32603,
          message:
            status === 400
              ? "Invalid JSON request."
              : status === 413
                ? "Request body too large."
                : "Internal MCP server error.",
        },
        id: null,
      });
    } else if (!response.writableEnded) {
      response.end();
    }
  }
}

export function createMcpHttpServer(bearerToken: string): Server {
  if (bearerToken.length < minimumBearerLength) {
    throw new Error("The MCP HTTP bearer credential is too short.");
  }
  return createServer((request, response) => {
    if (!allowedHostHeader(request.headers.host)) {
      writeJson(response, 403, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid Host header." },
        id: null,
      });
      return;
    }

    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/mcp") {
      writeJson(response, 404, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Not found." },
        id: null,
      });
      return;
    }
    if (hasDisallowedOrigin(request.headers.origin)) {
      writeJson(response, 403, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Browser-origin requests are not allowed." },
        id: null,
      });
      return;
    }
    if (!isAuthorizedBearer(request.headers.authorization, bearerToken)) {
      writeJson(
        response,
        401,
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Authentication required." },
          id: null,
        },
        { "www-authenticate": 'Bearer realm="chictrip-mcp"' },
      );
      return;
    }
    if (request.method !== "POST") {
      writeJson(
        response,
        405,
        {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed for this stateless MCP endpoint.",
          },
          id: null,
        },
        { allow: "POST" },
      );
      return;
    }
    if (!isJsonContentType(request.headers["content-type"])) {
      writeJson(response, 415, {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Content-Type must be application/json.",
        },
        id: null,
      });
      return;
    }
    void handleMcpPost(request, response);
  });
}

async function shutdown(httpServer: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function start(): Promise<void> {
  const config = loadConfig();
  if (!loopbackHosts.has(config.httpHost)) {
    throw new Error(
      "CHICTRIP_MCP_HOST must be a loopback host. Use a secure MCP tunnel instead of exposing this credential-bearing adapter directly.",
    );
  }
  const credential = resolveHttpBearerCredential(config.httpBearerToken);
  if (credential.generated) {
    process.stderr.write(
      [
        "Generated an ephemeral chicTrip MCP bearer credential for this process.",
        "It changes on restart; configure CHICTRIP_MCP_BEARER_TOKEN for a secure tunnel.",
        `Authorization: Bearer ${credential.token}`,
        "",
      ].join("\n"),
    );
  }

  const httpServer = createMcpHttpServer(credential.token);
  httpServer.listen(config.httpPort, config.httpHost, () => {
    process.stderr.write(
      `chicTrip MCP listening on http://${config.httpHost}:${config.httpPort}/mcp\n`,
    );
  });

  process.once("SIGINT", () => {
    void shutdown(httpServer).finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown(httpServer).finally(() => process.exit(0));
  });
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntrypoint) {
  await start();
}
