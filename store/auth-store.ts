"use client";

import { create } from "zustand";
import { AuthPayload, loginRequest, registerRequest, walletLoginRequest } from "../lib/api";
import { connectPeraWallet, signLoginMessageWithPera } from "../lib/pera-wallet";
import { AUTH_STORAGE_KEY, LEGACY_AUTH_STORAGE_KEY } from "../lib/project-config";

type User = AuthPayload["user"];

function normalizeUserRole(user: User): User {
  const rawRole = String(user.role ?? "").toUpperCase();
  const normalizedRole =
    rawRole === "CLIENT"
      ? "CLIENT"
      : rawRole === "ADMIN"
        ? "ADMIN"
        : rawRole === "ARBITRATOR"
          ? "ARBITRATOR"
          : "FREELANCER";
  return {
    ...user,
    role: normalizedRole,
  };
}

interface AuthState {
  token: string | null;
  user: User | null;
  loading: boolean;
  error: string | null;
  setSession: (payload: AuthPayload) => void;
  setUser: (user: User | null) => void;
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
  loginWithPera: (role: "CLIENT" | "FREELANCER") => Promise<void>;
  logout: () => void;
}

function persistAuthState(data: AuthPayload) {
  if (typeof window !== "undefined") {
    const normalized = normalizeUserRole(data.user);
    window.localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ token: data.token, user: normalized }),
    );
  }
}

function getWalletLoginMessage(walletAddress: string) {
  return `BountyEscrow wallet login\nAddress: ${walletAddress}\nTimestamp: ${new Date().toISOString()}`;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  user: null,
  loading: false,
  error: null,
  setSession: (payload) => {
    const normalized = normalizeUserRole(payload.user);
    persistAuthState({ ...payload, user: normalized });
    set({ token: payload.token, user: normalized, error: null });
  },
  setUser: (user) => {
    if (typeof window !== "undefined") {
      const current = useAuthStore.getState();
      if (current.token && user) {
        window.localStorage.setItem(
          AUTH_STORAGE_KEY,
          JSON.stringify({ token: current.token, user: normalizeUserRole(user) }),
        );
      }
    }
    set({ user: user ? normalizeUserRole(user) : null });
  },
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
      const normalizedUser = normalizeUserRole(parsed.user);
      // Migrate old storage key to keep existing sessions working after rename.
      window.localStorage.setItem(
        AUTH_STORAGE_KEY,
        JSON.stringify({ token: parsed.token, user: normalizedUser }),
      );
      window.localStorage.removeItem(LEGACY_AUTH_STORAGE_KEY);
      set({ token: parsed.token, user: normalizedUser });
    } catch {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_AUTH_STORAGE_KEY);
    }
  },
  register: async (payload) => {
    set({ loading: true, error: null });
    try {
      const data = await registerRequest(payload);
      const normalized = normalizeUserRole(data.user);
      persistAuthState(data);
      set({ token: data.token, user: normalized, loading: false });
    } catch (error) {
      set({ loading: false, error: (error as Error).message });
      throw error;
    }
  },
  login: async (payload) => {
    set({ loading: true, error: null });
    try {
      const data = await loginRequest(payload);
      const normalized = normalizeUserRole(data.user);
      persistAuthState(data);
      set({ token: data.token, user: normalized, loading: false });
    } catch (error) {
      set({ loading: false, error: (error as Error).message });
      throw error;
    }
  },
  loginWithPera: async (role) => {
    set({ loading: true, error: null });
    try {
      const walletAddress = await connectPeraWallet();
      const signedMessage = getWalletLoginMessage(walletAddress);
      const signature = await signLoginMessageWithPera(walletAddress, signedMessage);

      const data = await walletLoginRequest({
        wallet_address: walletAddress,
        signed_message: signedMessage,
        signature,
        role: role === "CLIENT" ? "client" : "freelancer",
      });

      const normalized = normalizeUserRole(data.user);
      persistAuthState(data);
      set({ token: data.token, user: normalized, loading: false });
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
