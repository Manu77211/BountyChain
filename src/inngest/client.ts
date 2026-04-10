import { randomUUID } from "node:crypto";
import { EventSchemas, Inngest, InngestMiddleware, type Context } from "inngest";
import { logger as structuredLogger, logEvent } from "../utils/logger";
import type { BountyEscrowEvents } from "./events";
import {
  INNGEST_DEFAULT_MAX_ATTEMPTS,
  getEventPayload,
  toErrorDetail,
  writeDeadLetter,
} from "./shared";

function getEventName(event: { name?: string } | undefined) {
  return event?.name ?? "unknown";
}

function getJobName(fn: unknown) {
  if (!fn || typeof fn !== "object") {
    return "unknown";
  }

  const candidate = fn as Record<string, unknown>;
  if (typeof candidate.name === "string" && candidate.name.trim()) {
    return candidate.name;
  }

  if (typeof candidate.id === "string" && candidate.id.trim()) {
    return candidate.id;
  }

  return "unknown";
}

function getRequestId(ctx: Context.Any) {
  const eventData = getEventPayload(ctx.event?.data);
  const fromPayload = eventData.request_id;
  if (typeof fromPayload === "string" && fromPayload.trim()) {
    return fromPayload;
  }
  return randomUUID();
}

const requestIdMiddleware = new InngestMiddleware({
  name: "request-id-middleware",
  init: () => ({
    onFunctionRun: () => ({
      transformInput: ({ ctx }) => {
        return {
          ctx: {
            request_id: getRequestId(ctx),
          },
        };
      },
    }),
  }),
});

const stepErrorLoggingMiddleware = new InngestMiddleware({
  name: "step-error-logging-middleware",
  init: () => ({
    onFunctionRun: ({ fn }) => {
      let currentContext: Context.Any | null = null;

      return {
        transformInput: ({ ctx }) => {
          currentContext = ctx;
          return;
        },
        transformOutput: ({ result, step }) => {
          if (!result.error || !currentContext) {
            return;
          }

          const detail = toErrorDetail(result.error);
          const requestId = (currentContext as Record<string, unknown>).request_id;
          logEvent("error", "Inngest step execution failed", {
            event_type: "inngest_step_error",
            job_name: getJobName(fn),
            event_name: getEventName(currentContext.event),
            step_name: step?.name ?? "unknown",
            request_id: typeof requestId === "string" ? requestId : undefined,
            run_id: currentContext.runId,
            attempt: currentContext.attempt + 1,
            max_attempts: currentContext.maxAttempts ?? INNGEST_DEFAULT_MAX_ATTEMPTS,
            detail: detail.message,
          });
        },
      };
    },
  }),
});

const deadLetterMiddleware = new InngestMiddleware({
  name: "dead-letter-middleware",
  init: () => ({
    onFunctionRun: ({ fn }) => {
      let currentContext: Context.Any | null = null;

      return {
        transformInput: ({ ctx }) => {
          currentContext = ctx;
          return;
        },
        transformOutput: async ({ result, step }) => {
          if (!result.error || !currentContext) {
            return;
          }

          const attemptNumber = currentContext.attempt + 1;
          const maxAttempts = currentContext.maxAttempts ?? INNGEST_DEFAULT_MAX_ATTEMPTS;
          if (attemptNumber < maxAttempts) {
            return;
          }

          await writeDeadLetter({
            eventName: getEventName(currentContext.event),
            payload: getEventPayload(currentContext.event?.data),
            error: result.error,
            jobName: getJobName(fn),
            stepName: step?.name,
            runId: currentContext.runId,
            attempt: attemptNumber,
            maxAttempts,
          });
        },
      };
    },
  }),
});

export const inngest = new Inngest({
  id: "bountyescrow-ai",
  eventKey: process.env.INNGEST_EVENT_KEY,
  logger: structuredLogger,
  schemas: new EventSchemas().fromRecord<BountyEscrowEvents>(),
  middleware: [requestIdMiddleware, stepErrorLoggingMiddleware, deadLetterMiddleware],
});

export const INNGEST_MAX_ATTEMPTS = INNGEST_DEFAULT_MAX_ATTEMPTS;
