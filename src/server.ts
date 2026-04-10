import http from "node:http";
import { Server } from "socket.io";
import app from "./app";

const PORT = Number(process.env.API_PORT ?? 4000);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((value) => value.trim()),
    credentials: true,
  },
});

app.set("io", io);

io.on("connection", (socket) => {
  socket.on("disconnect", () => {
    // Connection cleanup handled by socket.io internals.
  });
});

server.listen(PORT, () => {
  console.log(`BountyEscrow API listening on :${PORT}`);
});
