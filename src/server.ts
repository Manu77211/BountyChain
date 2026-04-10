import "../lib/load-env";
import http from "node:http";
import app from "./app";
import { initializeRealtime } from "./realtime/socket";
import { registerProcessErrorHandlers } from "./middleware/errorHandler";
import { logEvent } from "./utils/logger";

const PORT = Number(process.env.API_PORT ?? 4000);

const server = http.createServer(app);
const io = initializeRealtime(server);

app.set("io", io);
registerProcessErrorHandlers(server);

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
