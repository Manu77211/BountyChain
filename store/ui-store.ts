"use client";

import { create } from "zustand";

type ThemeMode = "light" | "dark";

export type UiNotification = {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  unread: boolean;
  type: "info" | "warning" | "ai";
  href: string;
};

interface UiState {
  sidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  theme: ThemeMode;
  notifications: UiNotification[];
  hydrated: boolean;
  hydrate: () => void;
  toggleSidebarCollapsed: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setMobileSidebarOpen: (open: boolean) => void;
  toggleTheme: () => void;
  addNotification: (notification: UiNotification) => void;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
}

const SIDEBAR_KEY = "ui.sidebar.collapsed";
const THEME_KEY = "ui.theme";

function readInitialTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "light";
  }

  const stored = window.localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") {
    return stored;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: ThemeMode) {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.dataset.theme = theme;
}

export const useUiStore = create<UiState>((set, get) => ({
  sidebarCollapsed: false,
  mobileSidebarOpen: false,
  theme: "light",
  notifications: [],
  hydrated: false,
  hydrate: () => {
    if (typeof window === "undefined") {
      return;
    }

    const collapsed = window.localStorage.getItem(SIDEBAR_KEY) === "1";
    const theme = readInitialTheme();
    applyTheme(theme);

    set({
      sidebarCollapsed: collapsed,
      theme,
      hydrated: true,
    });
  },
  toggleSidebarCollapsed: () => {
    const next = !get().sidebarCollapsed;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
    }
    set({ sidebarCollapsed: next });
  },
  setSidebarCollapsed: (collapsed) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
    }
    set({ sidebarCollapsed: collapsed });
  },
  setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
  toggleTheme: () => {
    const next: ThemeMode = get().theme === "light" ? "dark" : "light";
    if (typeof window !== "undefined") {
      window.localStorage.setItem(THEME_KEY, next);
    }
    applyTheme(next);
    set({ theme: next });
  },
  addNotification: (notification) => {
    set((state) => ({
      notifications: [notification, ...state.notifications.filter((item) => item.id !== notification.id)],
    }));
  },
  markNotificationRead: (id) => {
    set((state) => ({
      notifications: state.notifications.map((item) =>
        item.id === id ? { ...item, unread: false } : item,
      ),
    }));
  },
  markAllNotificationsRead: () => {
    set((state) => ({
      notifications: state.notifications.map((item) => ({ ...item, unread: false })),
    }));
  },
}));
