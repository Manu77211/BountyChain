"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { PRODUCT_NAME } from "../lib/project-config";
import { useAuthStore } from "../store/auth-store";
import { Button } from "./ui/primitives";
import { FooterSectionBlock } from "./ui/footer-section";

const clientLinks = [
  { href: "/", label: "Home" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/dashboard/freelancers", label: "Freelancers" },
  { href: "/dashboard/bounties", label: "Create Bounty" },
];

const freelancerLinks = [
  { href: "/", label: "Home" },
  { href: "/dashboard", label: "My Bounties" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, hydrate, logout } = useAuthStore();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const links = user?.role === "CLIENT" ? clientLinks : freelancerLinks;

  return (
    <div className="flex min-h-screen flex-col bg-[#f0f0f0] text-[#121212]">
      <header className="sticky top-0 z-30 border-b-2 border-[#121212] bg-[#f0f0f0]">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
          <Link href="/" className="text-lg font-black uppercase tracking-tight text-[#121212]">
            {PRODUCT_NAME}
          </Link>

          <nav className="hidden gap-1 md:flex">
            {links.map((link) => {
              const active = pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                    active
                      ? "border-2 border-[#121212] bg-[#f0c020] text-[#121212]"
                      : "border-2 border-[#121212] bg-white text-[#121212] hover:bg-[#f5f5f5]"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>

          <button
            type="button"
            className="rounded-none border-2 border-[#121212] bg-white p-2 text-[#121212] md:hidden"
            onClick={() => setMobileOpen((value) => !value)}
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
          >
            {mobileOpen ? <X size={18} /> : <Menu size={18} />}
          </button>

          <div className="hidden items-center gap-2 md:flex">
            {user ? (
              <>
                <span className="rounded-none border border-[#121212] bg-[#f0c020] px-3 py-1 text-xs font-bold uppercase tracking-wide text-[#121212]">
                  {user.role === "CLIENT" ? "Client" : "Freelancer"}
                </span>
                <Button variant="ghost" onClick={logout}>Logout</Button>
              </>
            ) : (
              <>
                <Button asChild variant="ghost"><Link href="/login">Login</Link></Button>
                <Button asChild><Link href="/register">Register</Link></Button>
              </>
            )}
          </div>
        </div>

        {mobileOpen ? (
          <div className="border-t-2 border-[#121212] px-5 py-3 md:hidden">
            <div className="flex flex-col gap-2">
              {links.map((link) => {
                const active = pathname.startsWith(link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setMobileOpen(false)}
                    className={`border-2 border-[#121212] px-3 py-2 text-sm font-semibold ${active ? "bg-[#1040c0] text-white" : "bg-white text-[#121212]"}`}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ) : null}
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8 sm:px-8">{children}</main>

      <section className="px-6 pb-8 pt-4">
        <FooterSectionBlock />
      </section>
    </div>
  );
}
