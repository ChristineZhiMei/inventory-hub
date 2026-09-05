import type { ErrorCode } from "@inventory-hub/contracts";

const defaultStatus: Partial<Record<ErrorCode, number>> = {
  VALIDATION_ERROR: 422,
  INVALID_CODE: 400,
  INVALID_PARENT_TYPE: 422,
  IMAGE_REQUIRED: 422,
  IMAGE_LIMIT: 422,
  UNAUTHENTICATED: 401,
  CSRF_INVALID: 403,
  DESKTOP_ONLY: 403,
  NOT_FOUND: 404,
  NODE_DELETED: 410,
  VERSION_CONFLICT: 409,
  LOCATION_CHANGED: 409,
  SUBTREE_CHANGED: 409,
  INVALID_STATE: 409,
  NONEMPTY_CONTAINER: 409,
  SYSTEM_NODE_PROTECTED: 409,
  REFERENCE_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  REQUEST_RUNNING: 409,
  REQUEST_PREPARATION_EXPIRED: 409,
  UPLOAD_ALREADY_ATTACHED: 409,
  FILE_TOO_LARGE: 413,
  PIXEL_LIMIT: 413,
  UNSUPPORTED_IMAGE: 415,
  RATE_LIMITED: 429,
  PROCESSING_BUSY: 429,
  STORAGE_OFFLINE: 503,
  MAINTENANCE: 503,
  DB_UNAVAILABLE: 503,
  DATABASE_BUSY: 503,
  EXECUTOR_OFFLINE: 503,
  DATA_INTEGRITY_ERROR: 500,
  MEDIA_MISSING: 500,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: unknown | undefined;
  readonly fields: Record<string, string[]> | undefined;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: { statusCode?: number; details?: unknown; fields?: Record<string, string[]>; retryable?: boolean } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = options.statusCode ?? defaultStatus[code] ?? 500;
    this.details = options.details;
    this.fields = options.fields;
    this.retryable = options.retryable ?? ["DATABASE_BUSY", "DB_UNAVAILABLE", "STORAGE_OFFLINE", "PROCESSING_BUSY"].includes(code);
  }
}

export function invariant(condition: unknown, code: ErrorCode, message: string, details?: unknown): asserts condition {
  if (!condition) throw new AppError(code, message, { details });
}
