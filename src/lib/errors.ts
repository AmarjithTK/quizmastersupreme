/**
 * The single error envelope every route handler returns.
 * PLAN.md §10.3.
 */

export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "DUPLICATE"
  | "RATE_LIMITED"
  | "INTERNAL";

const STATUS: Record<ApiErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 422,
  CONFLICT: 409,
  DUPLICATE: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return STATUS[this.code];
  }
}

export const unauthorized = (message = "Sign in to continue") =>
  new ApiError("UNAUTHORIZED", message);
export const forbidden = (message = "You do not have access to this") =>
  new ApiError("FORBIDDEN", message);
export const notFound = (message = "Not found") => new ApiError("NOT_FOUND", message);
export const validationError = (message: string, details?: unknown) =>
  new ApiError("VALIDATION", message, details);
export const conflict = (message: string) => new ApiError("CONFLICT", message);

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return Response.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      { status: error.status, headers: { "cache-control": "no-store" } },
    );
  }

  console.error("Unhandled API error", error);
  return Response.json(
    { error: { code: "INTERNAL", message: "Something went wrong" } },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
}

export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, {
    ...init,
    headers: { "cache-control": "no-store", ...(init?.headers ?? {}) },
  });
}
