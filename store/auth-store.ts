"use client";

import { create } from "zustand";
import { AuthPayload, loginRequest, registerRequest } from "../lib/api";
import { AUTH_STORAGE_KEY, LEGACY_AUTH_STORAGE_KEY } from "../lib/project-config";

type User = AuthPayload["user"];

interface AuthState {
  token: string | null;
  user: User | null;
  loading: boolean;
  error: string | null;
  hydrate: () => void;
  register: (payload: {
    name: string;
    email: string;
    password: string;
    role: "CLIENT" | "FREELANCER";
    skills?: string[];
    experience?: string;
    portfolio?: string[];
  }) => Promise<void>;
  login: (payload: { email: string; password: string }) => Promise<void>;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  user: null,
  loading: false,
  error: null,
  hydrate: () => {
    if (typeof window === "undefined") {
      return;
    }

    const raw =
      window.localStorage.getItem(AUTH_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_AUTH_STORAGE_KEY);
    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw) as { token: string; user: User };
      // Migrate old storage key to keep existing sessions working after rename.
      window.localStorage.setItem(AUTH_STORAGE_KEY, raw);
      window.localStorage.removeItem(LEGACY_AUTH_STORAGE_KEY);
      set({ token: parsed.token, user: parsed.user });
    } catch {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_AUTH_STORAGE_KEY);
    }
  },
  register: async (payload) => {
    set({ loading: true, error: null });
    try {
      const data = await registerRequest(payload);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          AUTH_STORAGE_KEY,
          JSON.stringify({ token: data.token, user: data.user }),
        );
      }
      set({ token: data.token, user: data.user, loading: false });
    } catch (error) {
      set({ loading: false, error: (error as Error).message });
      throw error;
    }
  },
  login: async (payload) => {
    set({ loading: true, error: null });
    try {
      const data = await loginRequest(payload);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          AUTH_STORAGE_KEY,
          JSON.stringify({ token: data.token, user: data.user }),
        );
      }
      set({ token: data.token, user: data.user, loading: false });
    } catch (error) {
      set({ loading: false, error: (error as Error).message });
      throw error;
    }
  },
  logout: () => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
    }
    set({ token: null, user: null, error: null });
  },
}));
