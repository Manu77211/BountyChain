import { randomUUID } from "node:crypto";
import cors from "cors";
import cookieParser from "cookie-parser";
import express from "express";
import authRoutes from "./routes/auth";
import bountyRoutes from "./routes/bounties";
import userRoutes from "./routes/users";
import { inngestApp } from "./jobs";
import githubWebhookRoutes from "./webhooks/github";
import { AppError, errorHandler, notFoundHandler } from "./middleware/errorHandler";

const app = express();

const allowedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use((request, _response, next) => {
  request.requestId = randomUUID();
  next();
});

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new AppError(403, 403, "API-004: Origin is not allowed by CORS"));
    },
    credentials: true,
  }),
);

app.use("/api/webhooks", githubWebhookRoutes);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.get("/healthz", (_request, response) => {
  response.status(200).json({ ok: true, service: "bountyescrow-api" });
});

app.use("/api/auth", authRoutes);
app.use("/api/bounties", bountyRoutes);
app.use("/api/users", userRoutes);
app.use("/api/inngest", inngestApp);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
