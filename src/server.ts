import "../lib/load-env";
import http from "node:http";
import app from "./app";
import { initializeRealtime } from "./realtime/socket";
import { registerProcessErrorHandlers } from "./middleware/errorHandler";
import { logEvent } from "./utils/logger";

const PORT = Number(process.env.API_PORT ?? 4000);

const server = http.createServer(app);
const io = initializeRealtime(server);

async function isApiAlreadyRunning(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1500),
    });

    if (!response.ok) {
      return false;
    }

    const payload = (await response.json()) as {
      ok?: boolean;
      service?: string;
    };

    return payload.ok === true && payload.service === "bountyescrow-api";
  } catch {
    return false;
  }
}

async function handleServerStartupError(error: NodeJS.ErrnoException) {
  if (error.code === "EADDRINUSE") {
    const alreadyRunning = await isApiAlreadyRunning(PORT);

    if (alreadyRunning) {
      logEvent("warn", "API server already running", {
        event_type: "api_server_already_running",
        port: PORT,
      });
      process.exit(0);
      return;
    }

    logEvent("error", "API port is already in use by another process", {
      event_type: "api_server_port_in_use",
      port: PORT,
    });
    process.exit(1);
    return;
  }

  logEvent("error", "API server failed to start", {
    event_type: "api_server_start_failed",
    port: PORT,
    error_code: error.code,
    detail: error.message,
  });
  process.exit(1);
}

app.set("io", io);
registerProcessErrorHandlers(server);

server.on("error", (error) => {
  void handleServerStartupError(error as NodeJS.ErrnoException);
});

io.on("connection", (socket) => {
  socket.on("disconnect", () => {
    // Connection cleanup handled by socket.io internals.
  });
});

server.listen(PORT, () => {
  logEvent("info", "API server started", {
    event_type: "api_server_started",
    port: PORT,
  });
});
