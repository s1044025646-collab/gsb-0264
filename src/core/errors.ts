export type ErrorCode =
  | "INVALID_SEQUENCE"
  | "SEQUENCE_TOO_LONG"
  | "PAGE_LABEL_INVALID"
  | "INVALID_CAPACITY"
  | "CAPACITY_TOO_LARGE"
  | "NOT_FOUND"
  | "STEP_OUT_OF_RANGE"
  | "INVALID_PAYLOAD"
  | "INVALID_QUERY"
  | "CONFLICT"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
