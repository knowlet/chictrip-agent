#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { ZodError } from "zod/v4";
import { createAppContext, type AppContext } from "./app.js";
import {
  AppError,
  exitCodeFor,
  toAppError,
  type ErrorCode,
} from "./domain/errors.js";
import type {
  ApplyTripChangeInput,
  TripChangeIntent,
} from "./domain/schemas.js";

interface ParsedArguments {
  positionals: string[];
  flags: Map<string, string>;
}

interface SuccessEnvelope {
  ok: true;
  command: string;
  data: unknown;
}

interface ErrorEnvelope {
  ok: false;
  command: string;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
}

type JsonEnvelope = SuccessEnvelope | ErrorEnvelope;

const COMMAND_HELP = {
  usage: "chictrip <command>",
  commands: [
    "capabilities",
    "auth status",
    "auth login [--timeout-ms <milliseconds>]",
    "trips list [--scope <all|owned|collaborating>] [--limit <1-100>]",
    "trips get <trip-id>",
    "places search --query <text> [--center-latitude <number>] [--center-longitude <number>] [--limit <1-30>]",
    "destinations search --query <text> [--limit <1-30>]",
    "changes preview --input <path|->",
    "changes approve <preview-id>",
    "changes apply --preview-id <uuid> --intent-hash <hash> --idempotency-key <uuid>",
    "changes status <operation-id|idempotency-key>",
  ],
  notes: [
    "All commands emit exactly one JSON object on stdout.",
    "Use '-' with changes preview to read the intent JSON from stdin.",
    "changes approve is local, interactive-only, and has no --yes or --force mode.",
  ],
};

function validationError(message: string, details?: unknown): AppError {
  return new AppError("VALIDATION_ERROR", message, {
    ...(details === undefined ? {} : { details }),
  });
}

function parseArguments(
  args: string[],
  options: {
    allowedFlags?: readonly string[];
    minimumPositionals?: number;
    maximumPositionals?: number;
  } = {},
): ParsedArguments {
  const allowedFlags = new Set(options.allowedFlags ?? []);
  const positionals: string[] = [];
  const flags = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const equalsIndex = argument.indexOf("=");
    const name =
      equalsIndex >= 0 ? argument.slice(2, equalsIndex) : argument.slice(2);
    if (!name || !allowedFlags.has(name)) {
      throw validationError(`Unknown option: --${name || "(empty)"}`);
    }
    if (flags.has(name)) {
      throw validationError(`Option may only be supplied once: --${name}`);
    }

    let value: string | undefined;
    if (equalsIndex >= 0) {
      value = argument.slice(equalsIndex + 1);
    } else {
      value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw validationError(`Option requires a value: --${name}`);
      }
      index += 1;
    }
    if (value.length === 0) {
      throw validationError(`Option requires a non-empty value: --${name}`);
    }
    flags.set(name, value);
  }

  const minimum = options.minimumPositionals ?? 0;
  const maximum = options.maximumPositionals ?? minimum;
  if (
    positionals.length < minimum ||
    positionals.length > maximum
  ) {
    const expected =
      minimum === maximum
        ? `${minimum}`
        : `${minimum}-${maximum}`;
    throw validationError(
      `Expected ${expected} positional argument(s), received ${positionals.length}.`,
    );
  }
  return { positionals, flags };
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw validationError(`Missing required option: --${name}`);
  return value;
}

function integerFlag(
  flags: Map<string, string>,
  name: string,
  fallback: number,
): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw validationError(`--${name} must be an integer.`);
  }
  return Number(raw);
}

function numberFlag(
  flags: Map<string, string>,
  name: string,
): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw validationError(`--${name} must be a finite number.`);
  }
  return value;
}

async function readJsonInput(path: string): Promise<unknown> {
  let raw: string;
  try {
    if (path === "-") {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      raw = Buffer.concat(chunks).toString("utf8");
    } else {
      raw = await readFile(path, "utf8");
    }
  } catch (error) {
    throw validationError(`Unable to read JSON input from ${path}.`, {
      cause: error instanceof Error ? error.message : "Unknown read error",
    });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw validationError(`Input from ${path} is not valid JSON.`, {
      cause: error instanceof Error ? error.message : "Unknown parse error",
    });
  }
}

async function approveChange(
  app: AppContext,
  previewId: string,
): Promise<unknown> {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) {
    throw new AppError(
      "APPROVAL_REQUIRED",
      "changes approve must be run in an interactive local terminal.",
      {
        details: {
          hint: `Run: chictrip changes approve ${previewId}`,
          nonInteractiveApproval: false,
        },
      },
    );
  }

  const state = await app.store.read();
  const stored = state.previews[previewId];
  if (!stored) {
    throw new AppError("NOT_FOUND", `Preview not found: ${previewId}`);
  }

  const expected = `APPLY ${stored.preview.approval.reviewCode}`;
  process.stderr.write(
    `${JSON.stringify(
      {
        previewId,
        intentHash: stored.preview.intentHash,
        expiresAt: stored.preview.expiresAt,
        diff: stored.preview.diff,
        blockers: stored.preview.blockers,
        warnings: stored.preview.warnings,
        estimatedProviderWrites: stored.preview.estimatedProviderWrites,
      },
      null,
      2,
    )}\n`,
  );
  process.stderr.write(
    "This records a short-lived local approval grant. It does not write to chicTrip yet.\n",
  );

  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  let typedConfirmation: string;
  try {
    typedConfirmation = await terminal.question(`Type exactly "${expected}": `);
  } finally {
    terminal.close();
  }
  if (typedConfirmation !== expected) {
    throw new AppError(
      "APPROVAL_INVALID",
      `Confirmation did not match. Type exactly: ${expected}`,
    );
  }

  const approval = await app.service.approve(
    previewId,
    typedConfirmation,
  );
  return {
    ...approval,
    approvalStoredLocally: true,
    next:
      "ChatGPT/MCP may now apply this preview once without receiving any approval secret.",
  };
}

async function changeStatus(
  app: AppContext,
  identifier: string,
): Promise<unknown> {
  const state = await app.store.read();
  const byKey = state.ledger[identifier];
  const entry =
    byKey ??
    Object.values(state.ledger).find(
      (candidate) => candidate.operationId === identifier,
    );
  if (!entry) {
    throw new AppError(
      "NOT_FOUND",
      `Change operation or idempotency key not found: ${identifier}`,
    );
  }
  return {
    idempotencyKey: entry.idempotencyKey,
    previewId: entry.previewId,
    intentHash: entry.intentHash,
    operationId: entry.operationId,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.result ? { result: entry.result } : {}),
  };
}

async function dispatch(
  app: AppContext,
  argv: string[],
): Promise<{ command: string; data: unknown }> {
  const [group, action, ...rest] = argv;

  if (!group || group === "help" || group === "--help" || group === "-h") {
    parseArguments(argv.slice(group ? 1 : 0), {
      minimumPositionals: 0,
      maximumPositionals: 0,
    });
    return { command: "help", data: COMMAND_HELP };
  }

  if (group === "capabilities") {
    parseArguments(argv.slice(1), {
      minimumPositionals: 0,
      maximumPositionals: 0,
    });
    return {
      command: "capabilities",
      data: await app.service.capabilities(),
    };
  }

  if (group === "auth" && action === "status") {
    parseArguments(rest, { minimumPositionals: 0, maximumPositionals: 0 });
    return { command: "auth.status", data: await app.session.status() };
  }

  if (group === "auth" && action === "login") {
    const parsed = parseArguments(rest, {
      allowedFlags: ["timeout-ms"],
      minimumPositionals: 0,
      maximumPositionals: 0,
    });
    const timeoutMs = integerFlag(parsed.flags, "timeout-ms", 10 * 60_000);
    if (timeoutMs < 1_000 || timeoutMs > 3_600_000) {
      throw validationError("--timeout-ms must be between 1000 and 3600000.");
    }
    process.stderr.write(
      "Opening the dedicated chicTrip browser profile. Complete login in that window.\n",
    );
    return {
      command: "auth.login",
      data: await app.session.login({ timeoutMs }),
    };
  }

  if (group === "trips" && action === "list") {
    const parsed = parseArguments(rest, {
      allowedFlags: ["scope", "limit"],
      minimumPositionals: 0,
      maximumPositionals: 0,
    });
    const scope = parsed.flags.get("scope") ?? "all";
    if (
      scope !== "all" &&
      scope !== "owned" &&
      scope !== "collaborating"
    ) {
      throw validationError(
        "--scope must be one of: all, owned, collaborating.",
      );
    }
    return {
      command: "trips.list",
      data: await app.service.listTrips({
        scope,
        limit: integerFlag(parsed.flags, "limit", 50),
      }),
    };
  }

  if (group === "trips" && action === "get") {
    const parsed = parseArguments(rest, {
      minimumPositionals: 1,
      maximumPositionals: 1,
    });
    return {
      command: "trips.get",
      data: await app.service.getTrip(parsed.positionals[0] ?? ""),
    };
  }

  if (group === "places" && action === "search") {
    const parsed = parseArguments(rest, {
      allowedFlags: [
        "query",
        "center-latitude",
        "center-longitude",
        "limit",
      ],
      minimumPositionals: 0,
      maximumPositionals: 0,
    });
    const centerLatitude = numberFlag(parsed.flags, "center-latitude");
    const centerLongitude = numberFlag(parsed.flags, "center-longitude");
    if ((centerLatitude === undefined) !== (centerLongitude === undefined)) {
      throw validationError(
        "--center-latitude and --center-longitude must be supplied together.",
      );
    }
    return {
      command: "places.search",
      data: await app.service.searchPlaces({
        query: requireFlag(parsed.flags, "query"),
        limit: integerFlag(parsed.flags, "limit", 10),
        ...(centerLatitude === undefined ? {} : { centerLatitude }),
        ...(centerLongitude === undefined ? {} : { centerLongitude }),
      }),
    };
  }

  if (group === "destinations" && action === "search") {
    const parsed = parseArguments(rest, {
      allowedFlags: ["query", "limit"],
      minimumPositionals: 0,
      maximumPositionals: 0,
    });
    return {
      command: "destinations.search",
      data: await app.service.searchDestinations({
        query: requireFlag(parsed.flags, "query"),
        limit: integerFlag(parsed.flags, "limit", 10),
      }),
    };
  }

  if (group === "changes" && action === "preview") {
    const parsed = parseArguments(rest, {
      allowedFlags: ["input"],
      minimumPositionals: 0,
      maximumPositionals: 0,
    });
    const input = await readJsonInput(requireFlag(parsed.flags, "input"));
    return {
      command: "changes.preview",
      data: await app.service.preview(input as TripChangeIntent),
    };
  }

  if (group === "changes" && action === "approve") {
    const parsed = parseArguments(rest, {
      minimumPositionals: 1,
      maximumPositionals: 1,
    });
    return {
      command: "changes.approve",
      data: await approveChange(app, parsed.positionals[0] ?? ""),
    };
  }

  if (group === "changes" && action === "apply") {
    const parsed = parseArguments(rest, {
      allowedFlags: [
        "preview-id",
        "intent-hash",
        "idempotency-key",
      ],
      minimumPositionals: 0,
      maximumPositionals: 0,
    });
    const request: ApplyTripChangeInput = {
      previewId: requireFlag(parsed.flags, "preview-id"),
      intentHash: requireFlag(parsed.flags, "intent-hash"),
      idempotencyKey: requireFlag(parsed.flags, "idempotency-key"),
    };
    return {
      command: "changes.apply",
      data: await app.service.apply(request),
    };
  }

  if (group === "changes" && action === "status") {
    const parsed = parseArguments(rest, {
      minimumPositionals: 1,
      maximumPositionals: 1,
    });
    return {
      command: "changes.status",
      data: await changeStatus(app, parsed.positionals[0] ?? ""),
    };
  }

  throw validationError(
    `Unknown command: ${argv.join(" ") || "(none)"}. Run 'chictrip help'.`,
  );
}

function normalizeError(error: unknown): AppError {
  if (error instanceof ZodError) {
    return validationError("Input validation failed.", {
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      })),
    });
  }
  return toAppError(error);
}

function emit(envelope: JsonEnvelope): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  app: AppContext = createAppContext(),
): Promise<number> {
  let command = argv.slice(0, 2).join(".") || "help";
  try {
    const result = await dispatch(app, argv);
    command = result.command;
    if (
      command === "changes.apply" &&
      result.data &&
      typeof result.data === "object"
    ) {
      const status = (result.data as { status?: string }).status;
      if (status && status !== "applied" && status !== "already_applied") {
        const code =
          status === "conflict"
            ? "CONFLICT"
            : status === "partial"
              ? "PROVIDER_PARTIAL"
              : status === "indeterminate"
                ? "PROVIDER_INDETERMINATE"
                : "PROVIDER_ERROR";
        throw new AppError(
          code,
          `The chicTrip change did not complete successfully (status: ${status}).`,
          { details: result.data },
        );
      }
    }
    emit({ ok: true, command, data: result.data });
    return 0;
  } catch (error) {
    const appError = normalizeError(error);
    const envelope: ErrorEnvelope = {
      ok: false,
      command,
      error: {
        code: appError.code,
        message: appError.message,
        retryable: appError.retryable,
        ...(appError.details === undefined
          ? {}
          : { details: appError.details }),
      },
    };
    emit(envelope);
    return exitCodeFor(appError);
  }
}

function isCliEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  if (pathToFileURL(entrypoint).href === import.meta.url) return true;
  try {
    return realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const isEntrypoint = isCliEntrypoint();

if (isEntrypoint) {
  void runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
