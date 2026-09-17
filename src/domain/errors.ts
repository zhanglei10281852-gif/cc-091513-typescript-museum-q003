/** 业务错误：携带稳定 code，HTTP 层据此映射状态码。 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export type ErrorCode =
  | "not_found"
  | "validation_error"
  | "forbidden"
  | "conflict"
  | "quota_exceeded"
  | "quota_unavailable"
  | "blocked_quorum"
  | "unknown_rule_version";

export function fail(
  code: ErrorCode,
  message: string,
  statusCode?: number,
  details?: unknown,
): never {
  throw new DomainError(code, message, statusCode, details);
}
