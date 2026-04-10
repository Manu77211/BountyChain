import type { NextFunction, Request, Response } from "express";
import type { Server as HttpServer } from "node:http";
import { ZodError } from "zod";
import type { DatabaseError as PgDatabaseError } from "pg";
import { logger } from "../utils/logger";

export class AuthError extends Error {}
export class ForbiddenError extends Error {}
export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class AlgorandError extends Error {}
export class DatabaseError extends Error {}

interface ClassifiedError {
  status: number;
  code: number;
  detail: string;
  retryAfter?: number;
  issues?: Record<string, string[]>;
}

function formatZodError(error: ZodError) {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "root";
    fieldErrors[key] = [...(fieldErrors[key] ?? []), issue.message];
  }
  return fieldErrors;
}

function classifyError(error: unknown): ClassifiedError {
  if (isAppErrorLike(error)) {
    return {
      status: error.status,
      code: error.code,
      detail: error.detail,
    };
  }

  if (error instanceof ZodError) {
    return {
      status: 400,
      code: 400,
      detail: "Validation failed",
      issues: formatZodError(error),
    };
  }

  if (error instanceof AuthError) {
    return { status: 401, code: 401, detail: error.message || "Unauthorized" };
  }

  if (error instanceof ForbiddenError) {
    return { status: 403, code: 403, detail: error.message || "Forbidden" };
  }

  if (error instanceof NotFoundError) {
    return { status: 404, code: 404, detail: error.message || "Not found" };
  }

  if (error instanceof ConflictError) {
    return { status: 409, code: 409, detail: error.message || "Conflict" };
  }

  if (error instanceof AlgorandError || getErrorMessage(error).includes("SC-")) {
    return {
      status: 502,
      code: 502,
      detail: `${getErrorMessage(error)}. Retry after a short backoff and verify on-chain status.`,
    };
  }

  if (isDatabaseError(error)) {
    return {
      status: 503,
      code: 503,
      detail: "Database unavailable",
      retryAfter: 15,
    };
  }

  const message = getErrorMessage(error);
  if (message.includes("Unauthorized") || message.includes("AUTH-")) {
    return { status: 401, code: 401, detail: message };
  }
  if (message.includes("Forbidden")) {
    return { status: 403, code: 403, detail: message };
  }
  if (message.toLowerCase().includes("not found")) {
    return { status: 404, code: 404, detail: message };
  }
  if (message.includes("duplicate") || message.includes("idempotency") || message.includes("conflict")) {
    return { status: 409, code: 409, detail: message };
  }

  return {
    status: 500,
    code: 500,
    detail: "API-005: Unexpected failure",
  };
}

function isAppErrorLike(error: unknown): error is { status: number; code: number; detail: string } {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { status?: unknown; code?: unknown; detail?: unknown };
  return (
    typeof candidate.status === "number" &&
    typeof candidate.code === "number" &&
    typeof candidate.detail === "string"
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

function isDatabaseError(error: unknown) {
  if (error instanceof DatabaseError) {
    return true;
  }

  const message = getErrorMessage(error).toLowerCase();
  const pgCode = (error as PgDatabaseError | undefined)?.code;
  if (typeof pgCode === "string" && pgCode.length > 0) {
    return true;
  }

  return (
    message.includes("database") ||
    message.includes("db-") ||
    message.includes("timeout") ||
    message.includes("too many clients")
  );
}

export function notFoundHandler(request: Request, response: Response) {
  return response.status(404).json({
    error: "Not Found",
    code: 404,
    detail: `Route ${request.method} ${request.path} does not exist`,
    request_id: request.requestId,
  });
}

export function globalErrorHandler(
  error: unknown,
  request: Request,
  response: Response,
  _next: NextFunction,
) {
  void _next;
  const classified = classifyError(error);

  logger.error(
    {
      request_id: request.requestId,
      user_id: request.user?.userId,
      route: request.path,
      method: request.method,
      error_code: classified.code,
      stack: error instanceof Error ? error.stack : undefined,
      event_type: "api_error",
    },
    getErrorMessage(error),
  );

  if (classified.retryAfter) {
    response.setHeader("Retry-After", String(classified.retryAfter));
  }

  return response.status(classified.status).json({
    error: "Request failed",
    code: classified.code,
    detail: classified.detail,
    issues: classified.issues,
    request_id: request.requestId,
  });
}

let processHandlersRegistered = false;

function gracefulShutdown(server?: HttpServer) {
  setTimeout(() => process.exit(1), 5_000).unref();
  if (!server) {
    process.exit(1);
    return;
  }
  server.close(() => process.exit(1));
}

export function registerProcessErrorHandlers(server?: HttpServer) {
  if (processHandlersRegistered) {
    return;
  }

  processHandlersRegistered = true;

  process.on("uncaughtException", (error) => {
    logger.error(
      {
        event_type: "uncaught_exception",
        error_code: "API-005",
        stack: error.stack,
      },
      error.message,
    );
    gracefulShutdown(server);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error(
      {
        event_type: "unhandled_rejection",
        error_code: "API-005",
        stack: reason instanceof Error ? reason.stack : undefined,
      },
      reason instanceof Error ? reason.message : "Unhandled rejection",
    );
    gracefulShutdown(server);
  });
}
