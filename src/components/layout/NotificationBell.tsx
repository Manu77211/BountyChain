"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Bot, AlertTriangle, CircleDot } from "lucide-react";
import { useRealtimeChannel } from "../../../lib/realtime-client";
import { useUiStore } from "../../../store/ui-store";

export type NotificationItem = {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  unread: boolean;
  type: "info" | "warning" | "ai";
  href: string;
};

function relativeTime(value: string) {
  const delta = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (delta < 60) {
    return `${delta}s ago`;
  }
  const minutes = Math.floor(delta / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function typeIcon(type: NotificationItem["type"]) {
  if (type === "warning") {
    return <AlertTriangle size={14} className="text-[#d02020]" />;
  }
  if (type === "ai") {
    return <Bot size={14} className="text-[#1040c0]" />;
  }
  return <CircleDot size={14} className="text-[#0f7b44]" />;
}

export function NotificationBell({ token }: { token: string | null }) {
  const router = useRouter();
  const {
    notifications,
    addNotification,
    markNotificationRead,
    markAllNotificationsRead,
  } = useUiStore();
  const [open, setOpen] = useState(false);

  useRealtimeChannel({
    token,
    onEvent: (event, payload) => {
      if (event !== "notification:new") {
        return;
      }

      const next: NotificationItem = {
        id: String(payload.notification_id ?? crypto.randomUUID()),
        title: String(payload.title ?? "New notification"),
        description: String(payload.detail ?? payload.message ?? "Open to view details."),
        createdAt: new Date().toISOString(),
        unread: true,
        type: String(payload.event_type ?? "").includes("ai") ? "ai" : "info",
        href: String(payload.href ?? "/dashboard/notifications"),
      };

      addNotification(next);
    },
  });

  useEffect(() => {
    if (notifications.length > 0) {
      return;
    }

    addNotification({
      id: "local-welcome",
      title: "Realtime updates enabled",
      description: "You will see new bounty and dispute notifications here.",
      createdAt: new Date().toISOString(),
      unread: false,
      type: "info",
      href: "/dashboard/notifications",
    });
  }, [addNotification, notifications.length]);

  const unreadCount = useMemo(
    () => notifications.filter((item) => item.unread).length,
    [notifications],
  );

  function openNotification(item: NotificationItem) {
    markNotificationRead(item.id);
    setOpen(false);
    router.push(item.href);
  }

  function markAllRead() {
    markAllNotificationsRead();
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Notifications"
        onClick={() => setOpen((value) => !value)}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-1 text-text-primary hover:bg-surface-3"
      >
        <Bell size={16} />
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-[#d02020] px-1 text-[10px] font-bold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-80 rounded-xl border border-border bg-surface-1 p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-text-primary">Notifications</p>
            <button
              type="button"
              onClick={markAllRead}
              className="text-xs font-semibold text-brand-400 hover:underline"
            >
              Mark all read
            </button>
          </div>

          <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
            {notifications.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-5 text-center">
                <p className="text-sm font-semibold text-text-primary">You are all caught up</p>
                <p className="mt-1 text-xs text-text-tertiary">No unread updates right now.</p>
              </div>
            ) : (
              notifications.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openNotification(item)}
                  className="w-full rounded-lg border border-border bg-surface-0 p-3 text-left hover:bg-surface-3"
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5">{typeIcon(item.type)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-semibold text-text-primary">{item.title}</p>
                        {item.unread ? <span className="h-2 w-2 rounded-full bg-[#1040c0]" /> : null}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-text-tertiary">{item.description}</p>
                      <p className="mt-1 text-[11px] text-text-tertiary">{relativeTime(item.createdAt)}</p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
