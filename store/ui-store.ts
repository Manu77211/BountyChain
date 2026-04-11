"use client";

import { create } from "zustand";

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
  notifications: UiNotification[];
  hydrated: boolean;
  hydrate: () => void;
  toggleSidebarCollapsed: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setMobileSidebarOpen: (open: boolean) => void;
  addNotification: (notification: UiNotification) => void;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
}

const SIDEBAR_KEY = "ui.sidebar.collapsed";

export const useUiStore = create<UiState>((set, get) => ({
  sidebarCollapsed: false,
  mobileSidebarOpen: false,
  notifications: [],
  hydrated: false,
  hydrate: () => {
    if (typeof window === "undefined") {
      return;
    }

    const collapsed = window.localStorage.getItem(SIDEBAR_KEY) === "1";

    set({
      sidebarCollapsed: collapsed,
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
