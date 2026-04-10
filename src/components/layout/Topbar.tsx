"use client";

import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { GlobalSearch } from "./GlobalSearch";
import { NotificationBell } from "./NotificationBell";
import { WalletChip } from "./WalletChip";
import { getPageTitle } from "./utils";

export function Topbar({ token, onOpenMobileMenu }: { token: string | null; onOpenMobileMenu: () => void }) {
  const pathname = usePathname();
  const title = getPageTitle(pathname);
  const network = (process.env.NEXT_PUBLIC_ALGORAND_NETWORK ?? "testnet").toUpperCase();

  return (
    <header className="sticky top-0 z-40 h-14 border-b border-border bg-surface-1/80 backdrop-blur-md">
      <div className="flex h-full items-center justify-between gap-3 px-4 md:px-6">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenMobileMenu}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-1 text-text-primary hover:bg-surface-3 md:hidden"
            aria-label="Open navigation"
          >
            <Menu size={16} />
          </button>
          <h1 className="text-sm font-semibold uppercase tracking-wide text-text-primary">{title}</h1>
        </div>

        <GlobalSearch token={token} />

        <div className="flex items-center gap-2">
          <span className="hidden rounded-full border border-border bg-surface-0 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-brand-400 sm:inline-flex">
            {network}
          </span>
          <NotificationBell token={token} />
          <WalletChip token={token} />
        </div>
      </div>
    </header>
  );
}
