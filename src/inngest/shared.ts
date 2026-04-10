import { dbQuery } from "../../lib/db/client";
import { logEvent } from "../utils/logger";

export const INNGEST_DEFAULT_MAX_ATTEMPTS = 3;

export interface DeadLetterInput {
  eventName: string;
  payload: Record<string, unknown>;
  error: unknown;
  jobName?: string;
  stepName?: string;
  runId?: string;
  attempt?: number;
  maxAttempts?: number;
}

export function toErrorDetail(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: typeof error === "string" ? error : JSON.stringify(error),
    stack: undefined,
  };
}

export async function writeDeadLetter(input: DeadLetterInput) {
  const detail = toErrorDetail(input.error);

  try {
    await dbQuery(
      `
        INSERT INTO dead_letter_jobs (
          event_name,
          payload,
          error,
          job_name,
          step_name,
          run_id,
          attempt,
          max_attempts,
          failed_at
        )
        VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, NOW())
      `,
      [
        input.eventName,
        JSON.stringify(input.payload),
        detail.message,
        input.jobName ?? null,
        input.stepName ?? null,
        input.runId ?? null,
        input.attempt ?? null,
        input.maxAttempts ?? null,
      ],
    );
  } catch (deadLetterError) {
    logEvent("error", "Failed to write dead-letter record", {
      event_type: "inngest_dead_letter_write_failed",
      event_name: input.eventName,
      detail: toErrorDetail(deadLetterError).message,
    });
  }
}

export function getEventPayload(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") {
    return {};
  }

  return data as Record<string, unknown>;
}

export function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

export async function createInAppNotification(
  userId: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  await dbQuery(
    `
      INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
      VALUES ($1, 'in_app', $2, $3::jsonb, FALSE, 0)
    `,
    [userId, eventType, JSON.stringify(payload)],
  );
}
