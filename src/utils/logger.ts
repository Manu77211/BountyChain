import pino, { type Logger, type LoggerOptions } from "pino";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface LogContext {
  request_id?: string;
  user_id?: string;
  bounty_id?: string;
  submission_id?: string;
  dispute_id?: string;
  event_type?: string;
  duration_ms?: number;
  [key: string]: unknown;
}

const SENSITIVE_PATTERNS = [
  "jwt",
  "token",
  "secret",
  "private_key",
  "signature",
  "raw_diff",
  "cached_diff",
];

function shouldRedactKey(key: string) {
  const normalized = key.toLowerCase();
  return SENSITIVE_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function sanitizeContext(context: LogContext) {
  const safeEntries = Object.entries(context).map(([key, value]) => {
    if (shouldRedactKey(key)) {
      return [key, "[REDACTED]"];
    }
    return [key, value];
  });
  return Object.fromEntries(safeEntries);
}

function createLoggerOptions(): LoggerOptions {
  const base: Record<string, unknown> = {
    service: "bountyescrow-api",
    environment: process.env.NODE_ENV ?? "development",
  };

  const aggregator = (process.env.LOG_AGGREGATOR ?? "stdout").toLowerCase();
  if (aggregator === "datadog" || aggregator === "logtail") {
    base.log_aggregator = aggregator;
  }

  return {
    level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info",
    base,
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    redact: {
      paths: [
        "req.headers.authorization",
        "authorization",
        "jwt",
        "token",
        "refresh_token",
        "signature",
        "wallet_private_key",
      ],
      remove: true,
    },
  };
}

export const logger: Logger = pino(createLoggerOptions());

export function childLogger(context: LogContext) {
  return logger.child(sanitizeContext(context));
}

export function logEvent(level: LogLevel, message: string, context: LogContext = {}) {
  const safeContext = sanitizeContext(context);
  logger[level](safeContext, message);
}
