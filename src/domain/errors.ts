/** 领域错误：携带稳定 code，HTTP 层据此映射状态码。 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function notFound(message: string, details?: unknown): never {
  throw new DomainError("not_found", message, 404, details);
}

export function conflict(code: string, message: string, details?: unknown): never {
  throw new DomainError(code, message, 409, details);
}

export function forbidden(message: string): never {
  throw new DomainError("forbidden", message, 403);
}

export function badRequest(message: string, details?: unknown): never {
  throw new DomainError("bad_request", message, 400, details);
}
