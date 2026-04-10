import type { NextFunction, Request, Response } from "express";
import { toDbErrorResponse } from "../../lib/db/errors";

export class AppError extends Error {
  status: number;
  code: number;
  detail: string;
  headers?: Record<string, string>;

  constructor(status: number, code: number, detail: string, message?: string) {
    super(message ?? detail);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function notFoundHandler(request: Request, response: Response) {
  return response.status(404).json({
    error: "Not Found",
    code: 404,
    detail: `Route ${request.method} ${request.path} does not exist`,
  });
}

export function errorHandler(
  error: unknown,
  request: Request,
  response: Response,
  _next: NextFunction,
) {
  const requestId = request.requestId;

  if (error instanceof AppError) {
    if (error.headers) {
      for (const [key, value] of Object.entries(error.headers)) {
        response.setHeader(key, value);
      }
    }
    return response.status(error.status).json({
      error: "Request failed",
      code: error.code,
      detail: error.detail,
      request_id: requestId,
    });
  }

  const dbMapped = toDbErrorResponse(error);
  if (dbMapped.status !== 500) {
    if (dbMapped.retryAfterSeconds) {
      response.setHeader("Retry-After", String(dbMapped.retryAfterSeconds));
    }
    return response.status(dbMapped.status).json({
      ...dbMapped.body,
      request_id: requestId,
    });
  }

  console.error("API-005 unhandled error", {
    requestId,
    method: request.method,
    path: request.path,
    message: error instanceof Error ? error.message : "Unknown error",
  });

  return response.status(500).json({
    error: "Internal server error",
    code: 500,
    detail: "API-005: Unexpected failure",
    request_id: requestId,
  });
}
