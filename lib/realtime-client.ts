"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { SOCKET_BASE_URL } from "./api";

export type RealtimeConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "unauthorized"
  | "disconnected";

export type RealtimeEventName =
  | "bounty:funded"
  | "bounty:accepted"
  | "bounty:ci_running"
  | "bounty:ci_passed"
  | "bounty:ci_failed"
  | "bounty:scoring"
  | "bounty:scored"
  | "bounty:payout_released"
  | "bounty:expired"
  | "bounty:deadline_extended"
  | "bounty:disputed"
  | "dispute:vote_cast"
  | "dispute:resolved"
  | "payout:mismatch_flagged"
  | "validation:opt_in_required"
  | "notification:new";

const TRACKED_EVENTS: RealtimeEventName[] = [
  "bounty:funded",
  "bounty:accepted",
  "bounty:ci_running",
  "bounty:ci_passed",
  "bounty:ci_failed",
  "bounty:scoring",
  "bounty:scored",
  "bounty:payout_released",
  "bounty:expired",
  "bounty:deadline_extended",
  "bounty:disputed",
  "dispute:vote_cast",
  "dispute:resolved",
  "payout:mismatch_flagged",
  "validation:opt_in_required",
  "notification:new",
];

interface UseRealtimeOptions {
  token: string | null;
  bountyId?: string;
  disputeId?: string;
  onSyncState?: (payload: Record<string, unknown>) => void;
  onEvent?: (event: RealtimeEventName, payload: Record<string, unknown>) => void;
}

function registerRooms(socket: Socket, bountyId?: string, disputeId?: string) {
  if (bountyId) {
    socket.emit("join:bounty", { bounty_id: bountyId });
    socket.emit("sync", { bounty_id: bountyId });
    socket.emit(`sync:${bountyId}`);
  }

  if (disputeId) {
    socket.emit("join:arbitration", { dispute_id: disputeId });
  }
}

export function useRealtimeChannel(options: UseRealtimeOptions) {
  const [state, setState] = useState<RealtimeConnectionState>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const onSyncRef = useRef(options.onSyncState);
  const onEventRef = useRef(options.onEvent);

  useEffect(() => {
    onSyncRef.current = options.onSyncState;
    onEventRef.current = options.onEvent;
  }, [options.onEvent, options.onSyncState]);

  useEffect(() => {
    if (!options.token) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      return;
    }

    const socket = io(SOCKET_BASE_URL, {
      transports: ["websocket"],
      auth: { token: options.token },
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      timeout: 8000,
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setState("connected");
      setLastError(null);
      registerRooms(socket, options.bountyId, options.disputeId);
    });

    socket.on("disconnect", () => {
      setState("disconnected");
    });

    socket.on("connect_error", (error: Error) => {
      const detail = error.message || "Realtime connection failed";
      setLastError(detail);
      if (detail.toLowerCase().includes("unauthorized") || detail.toLowerCase().includes("inactive auth session")) {
        setState("unauthorized");
        return;
      }
      setState("reconnecting");
    });

    socket.io.on("reconnect_attempt", () => {
      setState("reconnecting");
    });

    socket.on("sync:state", (payload: Record<string, unknown>) => {
      setLastSyncAt(new Date().toISOString());
      onSyncRef.current?.(payload);
    });

    for (const eventName of TRACKED_EVENTS) {
      socket.on(eventName, (payload: Record<string, unknown>) => {
        onEventRef.current?.(eventName, payload);
      });
    }

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [options.token, options.bountyId, options.disputeId]);

  const requestSync = useCallback(() => {
    if (!socketRef.current || !options.bountyId) {
      return;
    }

    socketRef.current.emit("sync", { bounty_id: options.bountyId });
  }, [options.bountyId]);

  return {
    state: options.token ? state : "idle",
    lastError: options.token ? lastError : null,
    lastSyncAt,
    requestSync,
  };
}
