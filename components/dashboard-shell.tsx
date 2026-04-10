"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useMemo, useState } from "react";
import {
  Bell,
  BriefcaseBusiness,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeft,
  Search,
  User,
  Wallet,
} from "lucide-react";
import { meRequest } from "../lib/api";
import { AUTH_STORAGE_KEY, PRODUCT_NAME } from "../lib/project-config";
import { useAuthStore } from "../store/auth-store";
import { Pill } from "./ui/primitives";

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
};

const SIDEBAR_STATE_KEY = "dashboard.sidebar.collapsed";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { token, user, hydrate, logout } = useAuthStore();
  const [walletBalance, setWalletBalance] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }

    return window.localStorage.getItem(SIDEBAR_STATE_KEY) === "1";
  });

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(SIDEBAR_STATE_KEY, sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (!token) {
      const hasStoredAuth = Boolean(window.localStorage.getItem(AUTH_STORAGE_KEY));
      if (hasStoredAuth) {
        return;
      }
      router.replace("/login");
    }
  }, [token, router]);

  useEffect(() => {
    async function loadProfile() {
      if (!token) {
        return;
      }

      try {
        const profile = await meRequest(token);
        setWalletBalance(profile.walletBalance ?? 0);
      } catch {
        setWalletBalance(0);
      }
    }

    void loadProfile();
  }, [token, pathname]);

  const navItems = useMemo<NavItem[]>(
    () => [
      {
        href: "/dashboard",
        label: "Dashboard",
        icon: <LayoutDashboard size={16} />,
      },
      {
        href: "/dashboard/bounties",
        label: user?.role === "FREELANCER" ? "My Bounties" : "Bounties",
        icon: <BriefcaseBusiness size={16} />,
      },
      {
        href: "/dashboard/freelancers",
        label: user?.role === "FREELANCER" ? "Marketplace" : "Freelancers",
        icon: <Search size={16} />,
      },
      {
        href: "/dashboard/wallet",
        label: "Escrow Wallet",
        icon: <Wallet size={16} />,
      },
      {
        href: "/dashboard/profile",
        label: "Profile",
        icon: <User size={16} />,
      },
    ],
    [user?.role],
  );

  const visibleNav = navItems;

  if (!token || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f0f0f0] text-[#121212]">
        Loading workspace...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,#fff3cd_0%,#f0f0f0_45%,#dbe9ff_100%)] text-[#121212]">
      <header className="sticky top-0 z-40 border-b-2 border-[#121212] bg-[#f0f0f0]/95 backdrop-blur">
        <div className="px-4 py-4 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="border-2 border-[#121212] bg-white p-2 text-[#121212] lg:hidden"
                onClick={() => setMobileOpen((value) => !value)}
                aria-label={mobileOpen ? "Close menu" : "Open menu"}
              >
                <Menu size={16} />
              </button>
              <Link href="/dashboard" className="text-xl font-black uppercase tracking-tight text-[#121212]">
                {PRODUCT_NAME}
              </Link>
              <button
                type="button"
                className="hidden border-2 border-[#121212] bg-white p-2 text-[#121212] lg:inline-flex"
                onClick={() => setSidebarCollapsed((value) => !value)}
                aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              >
                <PanelLeft size={16} />
              </button>
            </div>

            <nav className="hidden items-center gap-2 lg:flex">
              {visibleNav
                .filter((item) => ["/dashboard", "/dashboard/bounties", "/dashboard/freelancers", "/dashboard/projects"].includes(item.href))
                .map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => {
                        setMobileOpen(false);
                        setProfileOpen(false);
                      }}
                      className={`border-2 px-3 py-2 text-sm font-bold uppercase tracking-wide transition ${
                        active
                          ? "border-[#121212] bg-[#f0c020] text-[#121212]"
                          : "border-[#121212] bg-white text-[#121212] hover:bg-[#f5f5f5]"
                      }`}
                    >
                      {item.label}
                    </Link>
                  );
                })}
            </nav>

            <div className="flex items-center gap-2">
              <span className="hidden border border-[#121212] bg-[#f0c020] px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-[#121212] sm:inline-flex">
                Escrow ${walletBalance.toFixed(2)}
              </span>
              <Link href="/dashboard/notifications" className="border-2 border-[#121212] bg-white p-2 text-[#121212]" aria-label="Notifications">
                <Bell size={16} />
              </Link>

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setProfileOpen((value) => !value)}
                  className="inline-flex items-center gap-2 border-2 border-[#121212] bg-white px-3 py-2 text-sm"
                >
                  <Pill text={user.role === "CLIENT" ? "Client" : "Freelancer"} />
                  <ChevronDown size={14} />
                </button>

                {profileOpen ? (
                  <div className="absolute right-0 mt-2 w-52 border-2 border-[#121212] bg-white p-2 shadow-[6px_6px_0_#121212]">
                    <Link
                      href="/dashboard/profile"
                      onClick={() => setProfileOpen(false)}
                      className="block border border-transparent px-3 py-2 text-sm font-semibold text-[#121212] hover:border-[#121212] hover:bg-[#f5f5f5]"
                    >
                      View Profile
                    </Link>
                    <button
                      type="button"
                      onClick={() => {
                        setProfileOpen(false);
                        logout();
                        router.replace("/login");
                      }}
                      className="mt-1 flex w-full items-center gap-2 border border-transparent px-3 py-2 text-left text-sm font-semibold text-[#8f1515] hover:border-[#121212] hover:bg-[#ffe2e2]"
                    >
                      <LogOut size={14} />
                      Logout
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="flex gap-4 px-4 py-6 sm:px-6">
        {mobileOpen ? (
          <button
            type="button"
            className="fixed inset-0 z-20 bg-black/35 lg:hidden"
            onClick={() => setMobileOpen(false)}
            aria-label="Close sidebar overlay"
          />
        ) : null}

        <aside
          className={`${mobileOpen ? "block" : "hidden"} fixed inset-y-24 left-4 z-30 w-[18rem] border-2 border-[#121212] bg-white p-3 shadow-[6px_6px_0_#121212] lg:sticky lg:top-24 lg:block lg:h-[calc(100vh-7rem)] lg:shadow-[6px_6px_0_#121212] ${sidebarCollapsed ? "lg:w-20" : "lg:w-72"}`}
        >
          <div className="mb-3 flex items-center justify-between border-b border-[#121212] pb-3">
            {!sidebarCollapsed ? <p className="text-xs font-black uppercase tracking-[0.18em]">Navigation</p> : null}
            <button
              type="button"
              className="hidden border border-[#121212] bg-white p-1 text-[#121212] lg:inline-flex"
              onClick={() => setSidebarCollapsed((value) => !value)}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
            </button>
          </div>

          <div className="space-y-2">
            {visibleNav.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => {
                    setMobileOpen(false);
                    setProfileOpen(false);
                  }}
                  className={`flex items-center gap-2 border-2 px-3 py-2.5 text-sm font-semibold uppercase tracking-wide transition ${
                    active
                      ? "border-[#121212] bg-[#1040c0] text-white"
                      : "border-[#121212] bg-white text-[#121212] hover:bg-[#f5f5f5]"
                  } ${sidebarCollapsed ? "justify-center lg:px-2" : ""}`}
                >
                  {item.icon}
                  <span className={`${sidebarCollapsed ? "lg:hidden" : ""}`}>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </aside>

        <main className="min-w-0 flex-1 space-y-6 pb-6">{children}</main>
      </div>
    </div>
  );
}
