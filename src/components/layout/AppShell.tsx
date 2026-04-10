"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { GitPullRequest, Layers, LayoutDashboard, MessageSquare, Plus, Scale, Shield, Trophy, User, X } from "lucide-react";
import { useAuthStore } from "../../../store/auth-store";
import { useUiStore } from "../../../store/ui-store";
import { useRequireAuth } from "../../hooks/useRequireAuth";
import { useSocket } from "../../hooks/useSocket";
import { ReconnectBanner } from "./ReconnectBanner";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { MobileNav } from "./MobileNav";

function normalizeRole(role?: string) {
  return String(role ?? "").toLowerCase();
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, token, hydrate } = useAuthStore();
  const { hydrate: hydrateUi, mobileSidebarOpen, setMobileSidebarOpen } = useUiStore();
  const { isLoading } = useRequireAuth();
  const [activeDisputes] = useState(0);
  useSocket();

  useEffect(() => {
    hydrate();
    hydrateUi();
  }, [hydrate, hydrateUi]);

  const hideShell =
    pathname === "/" ||
    pathname.startsWith("/connect") ||
    pathname.startsWith("/auth/");

  const mobileItems = useMemo(() => {
    const role = normalizeRole(user?.role);
    const isClient = role === "client";
    const isFreelancer = role === "freelancer";
    const isAdmin = role === "admin";

    return [
      { href: "/dashboard", label: "Dashboard", icon: <LayoutDashboard size={16} />, visible: true },
      { href: "/dashboard/projects", label: "Applications", icon: <Layers size={16} />, visible: true },
      { href: "/dashboard/chat", label: "Conversations", icon: <MessageSquare size={16} />, visible: true },
      { href: "/bounties", label: "Bounties", icon: <Trophy size={16} />, visible: true },
      { href: "/bounties/create", label: "Post Bounty", icon: <Plus size={16} />, visible: isClient },
      { href: "/submissions", label: "My Work", icon: <GitPullRequest size={16} />, visible: isFreelancer },
      { href: "/disputes", label: "Disputes", icon: <Scale size={16} />, visible: true },
      { href: "/profile", label: "Profile", icon: <User size={16} />, visible: true },
      { href: "/admin", label: "Admin", icon: <Shield size={16} />, visible: isAdmin },
    ].filter((item) => item.visible);
  }, [user?.role]);

  if (hideShell) {
    return <>{children}</>;
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-0 text-text-primary">
        Loading workspace...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-0">
      <ReconnectBanner />
      <div className="flex min-h-screen bg-surface-0">
        <Sidebar activeDisputes={activeDisputes} />
        <div className="flex flex-1 flex-col">
          <Topbar token={token} onOpenMobileMenu={() => setMobileSidebarOpen(true)} />
          <main className="flex-1 overflow-auto pb-16 md:pb-0">
            <div className="mx-auto w-full max-w-7xl px-4 md:px-6 py-6">{children}</div>
          </main>
        </div>
      </div>

      {mobileSidebarOpen ? (
        <>
          <button
            type="button"
            onClick={() => setMobileSidebarOpen(false)}
            aria-label="Close mobile sidebar"
            className="fixed inset-0 z-50 bg-black/35 md:hidden"
          />
          <div className="fixed inset-x-0 bottom-0 z-[60] rounded-t-2xl border-t border-border bg-surface-1 p-4 shadow-2xl md:hidden">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold text-text-primary">Navigation</p>
              <button
                type="button"
                onClick={() => setMobileSidebarOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface-0"
              >
                <X size={14} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {mobileItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileSidebarOpen(false)}
                  className="flex items-center gap-2 rounded-lg border border-border bg-surface-0 px-3 py-2 text-sm font-semibold text-text-primary"
                >
                  {item.icon}
                  <span>{item.label}</span>
                </Link>
              ))}
            </div>
          </div>
        </>
      ) : null}

      <MobileNav />
    </div>
  );
}
