import { toDbErrorResponse } from "./errors";

export interface HttpErrorPayload {
  status: number;
  body: {
    error: string;
    code: number;
    detail: string;
  };
  headers?: Record<string, string>;
}

export function mapDatabaseErrorToHttp(error: unknown): HttpErrorPayload {
  const mapped = toDbErrorResponse(error);
  if (!mapped.retryAfterSeconds) {
    return { status: mapped.status, body: mapped.body };
  }

  return {
    status: mapped.status,
    body: mapped.body,
    headers: { "Retry-After": String(mapped.retryAfterSeconds) },
  };
}
