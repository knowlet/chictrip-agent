export type ErrorCode =
  | "VALIDATION_ERROR"
  | "AUTH_REQUIRED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_INVALID"
  | "APPROVAL_EXPIRED"
  | "PREVIEW_EXPIRED"
  | "PREVIEW_BLOCKED"
  | "UNSUPPORTED_CAPABILITY"
  | "IDEMPOTENCY_KEY_REUSED"
  | "PROVIDER_ERROR"
  | "PROVIDER_PARTIAL"
  | "PROVIDER_INDETERMINATE"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    return new AppError("INTERNAL_ERROR", error.message, { cause: error });
  }
  return new AppError("INTERNAL_ERROR", "Unexpected error.");
}

export function exitCodeFor(error: AppError): number {
  switch (error.code) {
    case "VALIDATION_ERROR":
      return 2;
    case "AUTH_REQUIRED":
      return 3;
    case "NOT_FOUND":
      return 4;
    case "CONFLICT":
    case "IDEMPOTENCY_KEY_REUSED":
      return 5;
    case "APPROVAL_REQUIRED":
    case "APPROVAL_INVALID":
    case "APPROVAL_EXPIRED":
    case "PREVIEW_EXPIRED":
    case "PREVIEW_BLOCKED":
      return 6;
    case "UNSUPPORTED_CAPABILITY":
      return 7;
    case "PROVIDER_ERROR":
      return 8;
    case "PROVIDER_PARTIAL":
    case "PROVIDER_INDETERMINATE":
      return 9;
    default:
      return 10;
  }
}
