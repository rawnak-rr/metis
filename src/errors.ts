/**
 * Stable machine-readable failure codes.
 *
 * Codes are part of the MCP contract: callers branch on `code`, not on message
 * text. Add new codes rather than repurposing existing ones.
 */
export type MetisErrorCode =
  // Ingestion request validation.
  | "INGEST_TITLE_EMPTY"
  | "INGEST_INPUT_AMBIGUOUS"
  | "INGEST_CONTENT_EMPTY"
  | "INGEST_UNSUPPORTED_TYPE"
  | "INGEST_SOURCE_NOT_FOUND"
  | "INGEST_SOURCE_NOT_A_FILE"
  | "INGEST_PATH_OUTSIDE_VAULT"
  | "INGEST_SOURCE_TOO_LARGE"
  | "INGEST_BATCH_EMPTY"
  | "INGEST_BATCH_TOO_LARGE"
  | "INGEST_DIRECTORY_MANAGED"
  // Text extraction.
  | "EXTRACT_NOT_UTF8"
  | "EXTRACT_EMPTY_TEXT"
  | "EXTRACT_PDF_TOOL_MISSING"
  | "EXTRACT_PDF_FAILED"
  | "EXTRACT_VISION_UNAVAILABLE"
  | "EXTRACT_VISION_NOT_CONFIGURED"
  | "EXTRACT_VISION_RATE_LIMITED"
  | "EXTRACT_VISION_REFUSED"
  | "EXTRACT_VISION_TRUNCATED"
  | "EXTRACT_VISION_FAILED"
  // Commit and integrity.
  | "INGEST_COPY_VERIFICATION_FAILED"
  | "INGEST_COMMIT_FAILED"
  | "SOURCE_INTEGRITY_FAILED";

/** Codes whose cause is transient; the same request may succeed on retry. */
const RETRYABLE_CODES = new Set<MetisErrorCode>([
  "EXTRACT_VISION_RATE_LIMITED",
  "EXTRACT_VISION_FAILED",
  "INGEST_COMMIT_FAILED",
]);

export class MetisError extends Error {
  readonly code: MetisErrorCode;
  readonly detail?: string;
  readonly retryable: boolean;

  constructor(
    code: MetisErrorCode,
    message: string,
    options: { detail?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MetisError";
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    if (options.detail) this.detail = options.detail;
  }
}

export interface MetisErrorPayload {
  code: MetisErrorCode | "UNEXPECTED_ERROR";
  message: string;
  retryable: boolean;
  detail?: string;
}

export function isMetisError(value: unknown): value is MetisError {
  return value instanceof MetisError;
}

/** Normalize any thrown value into the coded payload returned over MCP. */
export function errorPayload(error: unknown): MetisErrorPayload {
  if (isMetisError(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.detail ? { detail: error.detail } : {}),
    };
  }
  return {
    code: "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}
