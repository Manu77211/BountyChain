"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { MARKETING_COLORS as C } from "./theme";
import { useAuthStore } from "../../store/auth-store";

export function MarketingNav() {
  const router = useRouter();
  const { token, user, hydrate, logout } = useAuthStore();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const navItems = useMemo(
    () => [
      { href: "/features", label: "Features" },
      { href: "/marketplace", label: "Marketplace" },
      { href: "/people", label: "People" },
      { href: "/for-freelancers", label: "Bounties" },
      { href: "/pricing", label: "Pricing" },
      { href: "/faq", label: "FAQ" },
    ],
    [],
  );

  function onSignOut() {
    logout();
    setOpen(false);
    router.push("/");
  }

  return (
    <nav
      style={{
        borderBottom: `4px solid ${C.black}`,
        backgroundColor: C.bg,
        fontFamily: "'Outfit', sans-serif",
      }}
      className="sticky top-0 z-50"
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 md:h-20 md:px-12">
        <Link href="/" className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <div className="h-4 w-4 rounded-full" style={{ backgroundColor: C.red }} />
            <div className="h-4 w-4" style={{ backgroundColor: C.blue }} />
            <div
              className="h-4 w-4"
              style={{
                backgroundColor: C.yellow,
                clipPath: "polygon(50% 0%, 0% 100%, 100% 100%)",
              }}
            />
          </div>
          <span className="text-xl font-black uppercase tracking-tighter" style={{ color: C.black }}>
            BountyEscrow AI
          </span>
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-sm font-bold uppercase tracking-wider transition-colors duration-200"
              style={{ color: C.black }}
              onMouseEnter={(e) => ((e.target as HTMLElement).style.color = C.red)}
              onMouseLeave={(e) => ((e.target as HTMLElement).style.color = C.black)}
            >
              {item.label}
            </Link>
          ))}
        </div>

        <div className="hidden items-center gap-3 md:flex">
          {token && user ? (
            <>
              <Link
                href="/dashboard"
                className="px-5 py-2 text-sm font-bold uppercase tracking-wider text-white transition-all duration-200"
                style={{
                  border: `2px solid ${C.black}`,
                  backgroundColor: C.blue,
                  boxShadow: `4px 4px 0px 0px ${C.black}`,
                }}
              >
                Dashboard
              </Link>
              <button
                onClick={onSignOut}
                className="px-5 py-2 text-sm font-bold uppercase tracking-wider transition-all duration-200 active:translate-x-[2px] active:translate-y-[2px]"
                style={{
                  border: `2px solid ${C.black}`,
                  backgroundColor: C.white,
                  boxShadow: `4px 4px 0px 0px ${C.black}`,
                  color: C.black,
                }}
              >
                Sign Out
              </button>
            </>
          ) : (
            <>
              <Link
                href="/login"
                className="px-5 py-2 text-sm font-bold uppercase tracking-wider transition-all duration-200"
                style={{
                  border: `2px solid ${C.black}`,
                  backgroundColor: C.white,
                  boxShadow: `4px 4px 0px 0px ${C.black}`,
                  color: C.black,
                }}
              >
                Sign In
              </Link>
              <Link
                href="/register"
                className="px-5 py-2 text-sm font-bold uppercase tracking-wider text-white transition-all duration-200"
                style={{
                  border: `2px solid ${C.black}`,
                  backgroundColor: C.blue,
                  boxShadow: `4px 4px 0px 0px ${C.black}`,
                }}
              >
                Register
              </Link>
            </>
          )}
        </div>

        <button className="flex flex-col gap-1.5 p-2 md:hidden" onClick={() => setOpen(!open)}>
          {[0, 1, 2].map((i) => (
            <span key={i} className="block h-0.5 w-6" style={{ backgroundColor: C.black }} />
          ))}
        </button>
      </div>

      {open && (
        <div
          style={{ borderTop: `2px solid ${C.black}`, backgroundColor: C.bg }}
          className="flex flex-col gap-4 px-5 py-6 md:hidden"
        >
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="font-bold uppercase tracking-wider"
              style={{ color: C.black }}
              onClick={() => setOpen(false)}
            >
              {item.label}
            </Link>
          ))}
          {token && user ? (
            <>
              <Link
                href="/dashboard"
                className="mt-2 px-5 py-3 text-center font-bold uppercase tracking-wider text-white"
                style={{
                  border: `2px solid ${C.black}`,
                  backgroundColor: C.blue,
                  boxShadow: `4px 4px 0px 0px ${C.black}`,
                }}
                onClick={() => setOpen(false)}
              >
                Dashboard
              </Link>
              <button
                className="px-5 py-3 font-bold uppercase tracking-wider"
                style={{
                  border: `2px solid ${C.black}`,
                  backgroundColor: C.white,
                  boxShadow: `4px 4px 0px 0px ${C.black}`,
                  color: C.black,
                }}
                onClick={onSignOut}
              >
                Sign Out
              </button>
            </>
          ) : (
            <>
              <Link
                href="/login"
                className="mt-2 px-5 py-3 text-center font-bold uppercase tracking-wider"
                style={{
                  border: `2px solid ${C.black}`,
                  backgroundColor: C.white,
                  boxShadow: `4px 4px 0px 0px ${C.black}`,
                  color: C.black,
                }}
                onClick={() => setOpen(false)}
              >
                Sign In
              </Link>
              <Link
                href="/register"
                className="px-5 py-3 text-center font-bold uppercase tracking-wider text-white"
                style={{
                  border: `2px solid ${C.black}`,
                  backgroundColor: C.blue,
                  boxShadow: `4px 4px 0px 0px ${C.black}`,
                }}
                onClick={() => setOpen(false)}
              >
                Register
              </Link>
            </>
          )}
        </div>
      )}
    </nav>
  );
}
