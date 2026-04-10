"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  GitPullRequest,
  LayoutDashboard,
  Layers,
  MessageSquare,
  LogOut,
  Plus,
  Scale,
  Shield,
  Trophy,
  User,
} from "lucide-react";
import { meRequest } from "../../../lib/api";
import { PRODUCT_NAME } from "../../../lib/project-config";
import { useAuthStore } from "../../../store/auth-store";
import { useUiStore } from "../../../store/ui-store";
import { truncateAddress } from "./utils";

type SidebarItem = {
  href: string;
  label: string;
  icon: React.ReactNode;
  visible: boolean;
  badge?: number;
};

function roleOf(userRole?: string) {
  return String(userRole ?? "").toLowerCase();
}

function BrandLogo({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-text-primary" style={{ fontFamily: "'Outfit', var(--font-sans), sans-serif" }}>
      <span
        className="relative inline-flex h-7 w-7 items-center justify-center overflow-hidden border border-border"
        style={{
          background: "var(--surface-1)",
          boxShadow: "2px 2px 0 0 var(--accent-blue)",
        }}
        aria-hidden
      >
        <span
          className="absolute left-[4px] top-[4px] h-[7px] w-[7px] rounded-full"
          style={{ backgroundColor: "var(--accent-red)" }}
        />
        <span
          className="absolute right-[5px] top-[5px] h-[7px] w-[7px]"
          style={{ backgroundColor: "var(--accent-blue)" }}
        />
        <span
          className="absolute bottom-[4px] left-[6px] h-[8px] w-[11px]"
          style={{
            backgroundColor: "var(--accent-yellow)",
            clipPath: "polygon(50% 0%, 0% 100%, 100% 100%)",
          }}
        />
      </span>

      {!collapsed ? (
        <span className="truncate text-[1.22rem] font-black uppercase tracking-tight">{PRODUCT_NAME}</span>
      ) : null}
    </div>
  );
}

export function Sidebar({ activeDisputes = 0 }: { activeDisputes?: number }) {
  const pathname = usePathname();
  const router = useRouter();
  const { token, user, logout } = useAuthStore();
  const { sidebarCollapsed, toggleSidebarCollapsed } = useUiStore();
  const [walletAddress, setWalletAddress] = useState<string | null>(null);

  function onLogout() {
    logout();
    router.replace("/login");
  }

  useEffect(() => {
    async function loadWallet() {
      if (!token) {
        setWalletAddress(null);
        return;
      }

      try {
        const profile = await meRequest(token) as { user?: { wallet_address?: string | null } };
        setWalletAddress(profile.user?.wallet_address ?? null);
      } catch {
        setWalletAddress(null);
      }
    }

    void loadWallet();
  }, [token]);

  const role = roleOf(user?.role);
  const items = useMemo<SidebarItem[]>(() => {
    const isClient = role === "client";
    const isFreelancer = role === "freelancer";
    const isAdmin = role === "admin";

    return [
      {
        href: "/dashboard",
        label: "Dashboard",
        icon: <LayoutDashboard size={16} />,
        visible: true,
      },
      {
        href: "/bounties",
        label: "Bounties",
        icon: <Trophy size={16} />,
        visible: true,
      },
      {
        href: "/dashboard/projects",
        label: "Applications",
        icon: <Layers size={16} />,
        visible: true,
      },
      {
        href: "/dashboard/chat",
        label: "Conversations",
        icon: <MessageSquare size={16} />,
        visible: true,
      },
      {
        href: "/bounties/create",
        label: "Post Bounty",
        icon: <Plus size={16} />,
        visible: isClient,
      },
      {
        href: "/submissions",
        label: "My Work",
        icon: <GitPullRequest size={16} />,
        visible: isFreelancer,
      },
      {
        href: "/disputes",
        label: "Disputes",
        icon: <Scale size={16} />,
        visible: true,
        badge: activeDisputes,
      },
      {
        href: "/profile",
        label: "Profile",
        icon: <User size={16} />,
        visible: true,
      },
      {
        href: "/admin",
        label: "Admin",
        icon: <Shield size={16} />,
        visible: isAdmin,
      },
    ];
  }, [activeDisputes, role]);

  const visibleItems = items.filter((item) => item.visible);

  return (
    <aside
      className={`hidden border-r border-border md:flex md:flex-col ${sidebarCollapsed ? "md:w-[74px]" : "md:w-[272px]"}`}
      style={{
        background: "var(--surface-0)",
      }}
    >
      <div className="flex h-16 items-center border-b-2 border-[#121212] px-3">
        <Link href="/dashboard" className="w-full rounded-none px-1 py-1 hover:bg-surface-3">
          <BrandLogo collapsed={sidebarCollapsed} />
        </Link>
      </div>

      <div className="border-b border-border px-3 py-2">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-text-tertiary">
          {!sidebarCollapsed ? "Workspace" : "WS"}
        </p>
      </div>

      <nav className="flex-1 space-y-1.5 px-2 py-3">
        {visibleItems.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`group relative flex items-center gap-2 rounded-none border px-2.5 py-2.5 text-sm font-semibold transition-all ${
                active
                  ? "border-[#1040c0] bg-white text-[#121212]"
                  : "border-transparent text-text-primary hover:border-border hover:bg-surface-3"
              } ${sidebarCollapsed ? "justify-center" : ""}`}
              style={
                active
                  ? {
                      boxShadow: "3px 3px 0 0 #121212",
                    }
                  : undefined
              }
            >
              {item.icon}
              {!sidebarCollapsed ? <span className="truncate">{item.label}</span> : null}
              {!sidebarCollapsed && item.badge && item.badge > 0 ? (
                <span
                  className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
                  style={{ backgroundColor: "var(--accent-red)" }}
                >
                  {item.badge}
                </span>
              ) : null}
              {sidebarCollapsed && item.badge && item.badge > 0 ? (
                <span
                  className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: "var(--accent-red)" }}
                />
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-2 border-t border-border p-2">
        <div className="flex items-center gap-2 rounded-none border border-border bg-surface-1 px-2 py-2 text-xs text-text-primary">
          <span className="h-2 w-2 rounded-full bg-[#0f7b44]" />
          {!sidebarCollapsed ? <span className="truncate">{truncateAddress(walletAddress, 6, 4)}</span> : null}
        </div>

        <button
          type="button"
          onClick={onLogout}
          className={`flex w-full items-center gap-2 rounded-none border border-border bg-surface-1 px-2 py-2 text-xs font-semibold text-text-primary hover:bg-surface-3 ${sidebarCollapsed ? "justify-center" : ""}`}
          aria-label="Logout"
        >
          <LogOut size={14} />
          {!sidebarCollapsed ? <span>Logout</span> : null}
        </button>

        <button
          type="button"
          onClick={toggleSidebarCollapsed}
          className={`flex w-full items-center gap-2 rounded-none border border-border bg-surface-1 px-2 py-2 text-xs font-semibold text-text-primary hover:bg-surface-3 ${sidebarCollapsed ? "justify-center" : ""}`}
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          {!sidebarCollapsed ? <span>Collapse</span> : null}
        </button>
      </div>
    </aside>
  );
}
