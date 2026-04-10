"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useMemo, useState } from "react";
import {
  Bell,
  BriefcaseBusiness,
  ChevronDown,
  LayoutDashboard,
  LogOut,
  Menu,
  Search,
  User,
  Wallet,
} from "lucide-react";
import { meRequest } from "../lib/api";
import { AUTH_STORAGE_KEY, PRODUCT_NAME } from "../lib/project-config";
import { useAuthStore } from "../store/auth-store";
import { Pill, Workspace } from "./ui/primitives";

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  clientOnly?: boolean;
};

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { token, user, hydrate, logout } = useAuthStore();
  const [walletBalance, setWalletBalance] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

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
        label: "Freelancers",
        icon: <Search size={16} />,
        clientOnly: true,
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

  const visibleNav = navItems.filter((item) => !(item.clientOnly && user?.role !== "CLIENT"));

  if (!token || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f0f0f0] text-[#121212]">
        Loading workspace...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f0f0f0] text-[#121212]">
      <header className="sticky top-0 z-40 border-b-2 border-[#121212] bg-[#f0f0f0]">
        <Workspace className="py-4">
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
            </div>

            <nav className="hidden items-center gap-2 lg:flex">
              {visibleNav
                .filter((item) => ["/dashboard", "/dashboard/bounties", "/dashboard/freelancers"].includes(item.href))
                .map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
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
        </Workspace>
      </header>

      <Workspace className="flex gap-6 py-8">
        <aside
          className={`${mobileOpen ? "block" : "hidden"} fixed inset-x-5 top-24 z-30 border-2 border-[#121212] bg-white p-3 shadow-[6px_6px_0_#121212] lg:static lg:block lg:w-64 lg:shadow-none`}
        >
          <div className="space-y-2 lg:sticky lg:top-24">
            {visibleNav.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center gap-2 border-2 px-3 py-2.5 text-sm font-semibold uppercase tracking-wide transition ${
                    active
                      ? "border-[#121212] bg-[#1040c0] text-white"
                      : "border-[#121212] bg-white text-[#121212] hover:bg-[#f5f5f5]"
                  }`}
                >
                  {item.icon}
                  {item.label}
                </Link>
              );
            })}
          </div>
        </aside>

        <main className="min-w-0 flex-1 space-y-6">{children}</main>
      </Workspace>
    </div>
  );
}
