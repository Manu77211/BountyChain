export interface ApiErrorBody {
  error: string;
  code: number;
  detail: string;
}

export interface ApiErrorResponse {
  status: number;
  body: ApiErrorBody;
  retryAfterSeconds?: number;
}

export function toDbErrorResponse(error: unknown): ApiErrorResponse {
  const message = error instanceof Error ? error.message : "Unknown database error";

  if (isPoolExhaustionError(error)) {
    return {
      status: 503,
      retryAfterSeconds: 15,
      body: {
        error: "Database unavailable",
        code: 503,
        detail: "DB-002: Connection pool exhausted. Retry after backoff.",
      },
    };
  }

  if (message.includes("XC-001")) {
    return {
      status: 409,
      body: {
        error: "Submission blocked",
        code: 409,
        detail: "XC-001: Bounty creator cannot submit to own bounty.",
      },
    };
  }

  return {
    status: 500,
    body: {
      error: "Database failure",
      code: 500,
      detail: message,
    },
  };
}

function isPoolExhaustionError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const lowered = error.message.toLowerCase();
  return lowered.includes("timeout") || lowered.includes("too many clients");
}
