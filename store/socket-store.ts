"use client";

import { create } from "zustand";

interface SocketState {
  connected: boolean;
  reconnecting: boolean;
  setConnected: (value: boolean) => void;
  setReconnecting: (value: boolean) => void;
}

export const useSocketStore = create<SocketState>((set) => ({
  connected: false,
  reconnecting: false,
  setConnected: (value) => set({ connected: value }),
  setReconnecting: (value) => set({ reconnecting: value }),
}));
