"use client";

import { useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { authMeRequest, SOCKET_BASE_URL } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { useSocketStore } from "../../store/socket-store";
import { useUiStore } from "../../store/ui-store";

export function useSocket() {
  const { token, user, setUser } = useAuthStore();
  const { setConnected, setReconnecting, connected, reconnecting } = useSocketStore();
  const { addNotification } = useUiStore();
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!token || !user?.id) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setConnected(false);
      setReconnecting(false);
      return;
    }

    const socket = io(SOCKET_BASE_URL, {
      transports: ["websocket"],
      auth: { token },
      reconnection: true,
      reconnectionDelay: 600,
      reconnectionDelayMax: 4000,
      timeout: 8000,
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setReconnecting(false);
      socket.emit("join:user", { user_id: user.id });
    });

    socket.on("disconnect", () => {
      setConnected(false);
    });

    socket.io.on("reconnect_attempt", () => {
      setReconnecting(true);
    });

    socket.io.on("reconnect", async () => {
      setReconnecting(false);
      setConnected(true);
      socket.emit("join:user", { user_id: user.id });
      try {
        const refreshed = await authMeRequest(token);
        if (refreshed.user) {
          const next = {
            id: refreshed.user.id,
            name: refreshed.user.name,
            email: refreshed.user.email,
            role: refreshed.user.role,
            skills: refreshed.user.skills ?? [],
            rating: Number(refreshed.user.rating ?? 0),
            trustScore: Number(refreshed.user.trustScore ?? 0),
            experience: refreshed.user.experience ?? "",
            portfolio: refreshed.user.portfolio ?? [],
          };
          setUser(next);
        }
      } catch {
        // Ignore refresh errors during reconnection.
      }
    });

    socket.on("notification:new", (payload: Record<string, unknown>) => {
      addNotification({
        id: String(payload.notification_id ?? crypto.randomUUID()),
        title: String(payload.title ?? "New notification"),
        description: String(payload.detail ?? payload.message ?? "Open to view details."),
        createdAt: new Date().toISOString(),
        unread: true,
        type: String(payload.event_type ?? "").includes("ai")
          ? "ai"
          : String(payload.event_type ?? "").includes("warning")
            ? "warning"
            : "info",
        href: String(payload.href ?? "/dashboard/notifications"),
      });
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [addNotification, setConnected, setReconnecting, setUser, token, user?.id]);

  return { connected, reconnecting };
}
