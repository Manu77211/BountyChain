import { randomUUID } from "node:crypto";
import cors from "cors";
import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import authRoutes from "./routes/auth";
import bountyRoutes from "./routes/bounties";
import disputeRoutes from "./routes/disputes";
import submissionsRoutes from "./routes/submissions";
import userRoutes from "./routes/users";
import { inngestApp } from "./inngest/serve";
import githubWebhookRoutes from "./webhooks/github";
import { AppError, errorHandler, notFoundHandler } from "./middleware/errorHandler";
import {
  authPerIpRateLimiter,
  perIpRateLimiter,
  perUserRateLimiter,
  webhookPerRangeRateLimiter,
} from "./middleware/rateLimiter";
import healthRouter from "./health/health";
import { logEvent } from "./utils/logger";

const app = express();

const allowedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)
  .map((origin) => origin.replace(/\/+$/, ""));

function isLocalDevOrigin(origin: string) {
  if (process.env.NODE_ENV === "production") {
    return false;
  }

  return /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
}

app.use((request, _response, next) => {
  request.requestId = randomUUID();
  next();
});

app.disable("x-powered-by");
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      const normalizedOrigin = origin.replace(/\/+$/, "");

      if (allowedOrigins.includes(normalizedOrigin) || isLocalDevOrigin(normalizedOrigin)) {
        callback(null, true);
        return;
      }
      callback(new AppError(403, 403, "API-004: Origin is not allowed by CORS"));
    },
    credentials: true,
  }),
);

app.use((request, response, next) => {
  const startedAt = Date.now();
  response.on("finish", () => {
    logEvent("info", "HTTP request completed", {
      request_id: request.requestId,
      user_id: request.user?.userId,
      event_type: "http_request",
      method: request.method,
      path: request.originalUrl || request.path,
      status_code: response.statusCode,
      duration_ms: Date.now() - startedAt,
    });
  });
  next();
});

app.use("/api/webhooks", webhookPerRangeRateLimiter, githubWebhookRoutes);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use("/api", (request, response, next) => {
  if (request.path.startsWith("/webhooks")) {
    return next();
  }

  if (request.method === "GET") {
    return perIpRateLimiter(request, response, next);
  }

  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    return perUserRateLimiter(request, response, next);
  }

  return next();
});

app.get("/healthz", (_request, response) => {
  response.status(200).json({ ok: true, service: "bountyescrow-api" });
});

app.use("/api", healthRouter);

app.use("/api/auth", authPerIpRateLimiter, authRoutes);
app.use("/api/bounties", bountyRoutes);
app.use("/api/submissions", submissionsRoutes);
app.use("/api/users", userRoutes);
app.use("/api", disputeRoutes);
app.use("/api/inngest", perIpRateLimiter, inngestApp);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
