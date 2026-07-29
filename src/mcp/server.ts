import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, ZodError } from "zod/v4";
import { createAppContext, type AppContext } from "../app.js";
import {
  ApplyTripChangeInputSchema,
  ListTripsInputSchema,
  SearchDestinationsInputSchema,
  SearchPlacesInputSchema,
  TripChangeIntentSchema,
} from "../domain/schemas.js";
import { AppError, type ErrorCode } from "../domain/errors.js";

const SERVER_INSTRUCTIONS = [
  "Use chictrip_list_trips and chictrip_get_trip before planning an update.",
  "Resolve provider place and destination IDs with the search tools.",
  "Call chictrip_preview_trip_change and show the exact diff, warnings, and blockers to the user.",
  "Approval is deliberately unavailable through MCP: the user must run the preview's local CLI approval command.",
  "After local approval, call chictrip_apply_trip_change with the matching preview ID, intent hash, and one UUID idempotency key. The approval secret remains in local 0600 state and is never exposed to the model.",
  "After apply, inspect its verified reconciliation result or query chictrip_get_change_status.",
].join(" ");

const StatusInputSchema = z
  .object({
    operationId: z.uuid().optional(),
    idempotencyKey: z.uuid().optional(),
  })
  .refine(
    (input) =>
      Number(input.operationId !== undefined) +
        Number(input.idempotencyKey !== undefined) ===
      1,
    "Provide exactly one of operationId or idempotencyKey.",
  );

const PROVIDER_READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const LOCAL_READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const PREVIEW_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const APPLY_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const PUBLIC_ERROR_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: "The request did not match the chicTrip tool schema.",
  AUTH_REQUIRED: "Local chicTrip authentication is required.",
  NOT_FOUND: "The requested chicTrip resource was not found.",
  CONFLICT: "The itinerary changed and the approved operation was stopped.",
  APPROVAL_REQUIRED: "Fresh local approval is required before this change can run.",
  APPROVAL_INVALID: "The local approval does not match this change.",
  APPROVAL_EXPIRED: "The local approval has expired.",
  PREVIEW_EXPIRED: "The change preview has expired.",
  PREVIEW_BLOCKED: "The change preview contains unresolved blockers.",
  UNSUPPORTED_CAPABILITY: "This chicTrip capability is not enabled.",
  IDEMPOTENCY_KEY_REUSED: "The idempotency key cannot be used for this change.",
  PROVIDER_ERROR: "chicTrip returned an error and no provider diagnostics were exposed.",
  PROVIDER_PARTIAL: "The chicTrip change may have been only partially applied.",
  PROVIDER_INDETERMINATE: "The chicTrip change outcome could not be determined safely.",
  INTERNAL_ERROR: "The chicTrip operation failed without exposing internal diagnostics.",
};

const SENSITIVE_KEY_PARTS = [
  "authorization",
  "cookie",
  "setcookie",
  "accesstoken",
  "refreshtoken",
  "confirmationtoken",
  "apikey",
  "password",
  "clientsecret",
  "requestid",
  "traceid",
] as const;

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi;
const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const CAPABILITY_TOKEN_PATTERN =
  /\b[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{32,}\b/g;
const SECRET_ASSIGNMENT_PATTERN =
  /((?:access|refresh|confirmation)[_-]?token|authorization|api[_-]?key|password|client[_-]?secret)\s*[:=]\s*[^\s,;&]+/gi;
const SECRET_QUERY_PATTERN =
  /([?&](?:access_token|refresh_token|confirmation_token|token|api_key|key)=)[^&#\s]+/gi;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function redactString(value: string): string {
  return value
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(CAPABILITY_TOKEN_PATTERN, "[REDACTED_TOKEN]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1=[REDACTED]")
    .replace(SECRET_QUERY_PATTERN, "$1[REDACTED]");
}

export function redactMcpOutput(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactMcpOutput);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!isSensitiveKey(key)) output[key] = redactMcpOutput(nested);
  }
  return output;
}

export function publicMcpError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof ZodError) {
    return {
      code: "VALIDATION_ERROR",
      message: PUBLIC_ERROR_MESSAGES.VALIDATION_ERROR,
      retryable: false,
    };
  }
  const appError = error instanceof AppError ? error : undefined;
  const code = appError?.code ?? "INTERNAL_ERROR";
  return {
    code,
    message: PUBLIC_ERROR_MESSAGES[code],
    retryable: appError?.retryable ?? false,
  };
}

function success(data: unknown, summary: string) {
  const structuredContent = {
    ok: true,
    data: redactMcpOutput(data),
  };
  return {
    content: [{ type: "text" as const, text: summary }],
    structuredContent,
  };
}

function failure(error: unknown) {
  const safe = publicMcpError(error);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `${safe.code}: ${safe.message}`,
      },
    ],
    structuredContent: {
      ok: false,
      error: safe,
    },
  };
}

function incompleteApply(
  result: Awaited<ReturnType<AppContext["service"]["apply"]>>,
  summary: string,
) {
  const code =
    result.status === "conflict"
      ? "CONFLICT"
      : result.status === "partial"
        ? "PROVIDER_PARTIAL"
        : result.status === "indeterminate"
          ? "PROVIDER_INDETERMINATE"
          : result.status === "approval_required"
            ? "APPROVAL_REQUIRED"
            : "PROVIDER_ERROR";
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${code}: ${summary}` }],
    structuredContent: {
      ok: false,
      error: {
        code,
        message: summary,
        retryable: false,
      },
      data: redactMcpOutput({
        ...result,
        ...(result.reconciliation
          ? {
              reconciliation: {
                ...result.reconciliation,
                message: summary,
              },
            }
          : {}),
      }),
    },
  };
}

function guarded<T extends object>(
  callback: (input: T) => Promise<ReturnType<typeof success>>,
) {
  return async (input: T) => {
    try {
      return await callback(input);
    } catch (error) {
      return failure(error);
    }
  };
}

async function getChangeStatus(
  context: AppContext,
  input: z.infer<typeof StatusInputSchema>,
) {
  const parsed = StatusInputSchema.parse(input);
  const state = await context.store.read();
  const entry = parsed.idempotencyKey
    ? state.ledger[parsed.idempotencyKey]
    : Object.values(state.ledger).find(
        (candidate) => candidate.operationId === parsed.operationId,
      );
  if (!entry) {
    throw new AppError("NOT_FOUND", "No local change operation matched that ID.");
  }
  return {
    operationId: entry.operationId,
    status: entry.result?.status ?? entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.result?.tripId ? { tripId: entry.result.tripId } : {}),
    ...(entry.result?.revision ? { revision: entry.result.revision } : {}),
    ...(entry.result?.completedSteps !== undefined
      ? { completedSteps: entry.result.completedSteps }
      : {}),
    ...(entry.result?.totalSteps !== undefined
      ? { totalSteps: entry.result.totalSteps }
      : {}),
    ...(entry.result?.reconciliation
      ? { reconciliation: entry.result.reconciliation }
      : {}),
  };
}

export function createChicTripMcpServer(
  context: AppContext = createAppContext(),
): McpServer {
  const server = new McpServer(
    {
      name: "chictrip-agent",
      version: "0.1.0",
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(
    "chictrip_capabilities",
    {
      title: "Check chicTrip capabilities",
      description:
        "Check local login state and the exact read/write features currently enabled. This does not expose credentials.",
      inputSchema: {},
      annotations: PROVIDER_READ_ANNOTATIONS,
    },
    guarded(async () => {
      const capabilities = await context.service.capabilities();
      return success(
        capabilities,
        capabilities.authenticated
          ? "chicTrip is authenticated; inspect structuredContent for enabled capabilities."
          : "chicTrip is not authenticated. Complete local CLI login before reading trips.",
      );
    }),
  );

  server.registerTool(
    "chictrip_list_trips",
    {
      title: "List chicTrip itineraries",
      description:
        "List the authenticated user's owned and collaborative chicTrip itineraries. Use this before choosing a trip to read or modify.",
      inputSchema: ListTripsInputSchema,
      annotations: PROVIDER_READ_ANNOTATIONS,
    },
    guarded(async (input) => {
      const trips = await context.service.listTrips(input);
      return success(trips, `Found ${trips.length} chicTrip itineraries.`);
    }),
  );

  server.registerTool(
    "chictrip_get_trip",
    {
      title: "Read a chicTrip itinerary",
      description:
        "Read one itinerary with dates, destinations, ordered daily items, and revision. Preserve the revision when preparing an update preview.",
      inputSchema: {
        tripId: z.string().trim().min(1).describe("The chicTrip itinerary ID."),
      },
      annotations: PROVIDER_READ_ANNOTATIONS,
    },
    guarded(async ({ tripId }) => {
      const trip = await context.service.getTrip(tripId);
      return success(trip, `Read chicTrip itinerary “${trip.title}”.`);
    }),
  );

  server.registerTool(
    "chictrip_search_places",
    {
      title: "Search chicTrip places",
      description:
        "Search chicTrip's place catalog and return provider place IDs required when adding itinerary items.",
      inputSchema: SearchPlacesInputSchema,
      annotations: PROVIDER_READ_ANNOTATIONS,
    },
    guarded(async (input) => {
      const places = await context.service.searchPlaces(input);
      return success(places, `Found ${places.length} matching chicTrip places.`);
    }),
  );

  server.registerTool(
    "chictrip_search_destinations",
    {
      title: "Search chicTrip destinations",
      description:
        "Search chicTrip's destination catalog and return provider location keys required for trip creation or destination changes.",
      inputSchema: SearchDestinationsInputSchema,
      annotations: PROVIDER_READ_ANNOTATIONS,
    },
    guarded(async (input) => {
      const destinations = await context.service.searchDestinations(input);
      return success(
        destinations,
        `Found ${destinations.length} matching chicTrip destinations.`,
      );
    }),
  );

  server.registerTool(
    "chictrip_preview_trip_change",
    {
      title: "Preview a chicTrip change",
      description:
        "Validate and preview a create or update intent without changing the provider itinerary. Show the returned diff, warnings, blockers, review code, and local approval command to the user.",
      inputSchema: TripChangeIntentSchema,
      annotations: PREVIEW_ANNOTATIONS,
    },
    guarded(async (intent) => {
      const preview = await context.service.preview(intent);
      return success(
        preview,
        preview.blockers.length > 0
          ? `Preview created with ${preview.blockers.length} blocker(s); no apply is allowed.`
          : `Preview created with ${preview.diff.length} change(s). User approval must happen through the local CLI.`,
      );
    }),
  );

  server.registerTool(
    "chictrip_apply_trip_change",
    {
      title: "Apply an approved chicTrip change",
      description:
        "Apply exactly one previously previewed and locally approved change. Requires the matching preview UUID, intent hash, and one UUID idempotency key. The human approval grant is loaded and consumed from protected local state; it is never passed through MCP. Reuse the same key only to inspect/recover the same attempt, and never generate a new key for an already attempted preview.",
      inputSchema: ApplyTripChangeInputSchema,
      annotations: APPLY_ANNOTATIONS,
    },
    guarded(async (input) => {
      const result = await context.service.apply(input);
      const summaries = {
        applied: "The approved chicTrip change was applied and verified by read-back.",
        already_applied:
          "This idempotent chicTrip change was already applied; no duplicate write was made.",
        approval_required:
          "The chicTrip change was not applied because fresh local approval is required.",
        conflict:
          "The chicTrip change was not applied because the itinerary revision conflicts with the preview.",
        partial:
          "The chicTrip change was only partially applied. Stop further writes and reconcile the itinerary.",
        indeterminate:
          "The chicTrip change outcome is indeterminate. Read the itinerary and reconcile before retrying.",
        failed:
          "The chicTrip change was not successfully applied. Inspect the structured status before taking further action.",
      } as const;
      const summary = summaries[result.status];
      return result.status === "applied" || result.status === "already_applied"
        ? success(result, summary)
        : incompleteApply(result, summary);
    }),
  );

  server.registerTool(
    "chictrip_get_change_status",
    {
      title: "Check chicTrip change status",
      description:
        "Read the local idempotency ledger for an earlier apply operation by operation UUID or idempotency-key UUID. This never retries a write.",
      inputSchema: StatusInputSchema,
      annotations: LOCAL_READ_ANNOTATIONS,
    },
    guarded(async (input) => {
      const status = await getChangeStatus(context, input);
      return success(status, `chicTrip change status: ${status.status}.`);
    }),
  );

  return server;
}
