"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Copy, ExternalLink, LogOut, RefreshCw, Wallet } from "lucide-react";
import { meRequest } from "../../../lib/api";
import { useAuthStore } from "../../../store/auth-store";
import { truncateAddress } from "./utils";

function explorerUrl(address: string, network: string) {
  const net = network.toLowerCase() === "mainnet" ? "mainnet" : "testnet";
  return `https://lora.algokit.io/${net}/account/${address}`;
}

export function WalletChip({ token }: { token: string | null }) {
  const router = useRouter();
  const { logout } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState<string | null>(null);

  const network = (process.env.NEXT_PUBLIC_ALGORAND_NETWORK ?? "testnet").toLowerCase();

  useEffect(() => {
    async function loadWallet() {
      if (!token) {
        setAddress(null);
        return;
      }

      try {
        const profile = await meRequest(token) as { user?: { wallet_address?: string | null } };
        setAddress(profile.user?.wallet_address ?? null);
      } catch {
        setAddress(null);
      }
    }

    void loadWallet();
  }, [token]);

  const shortAddress = useMemo(() => truncateAddress(address, 8, 6), [address]);

  async function copyAddress() {
    if (!address) {
      return;
    }
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      // Ignore clipboard failure in restricted contexts.
    }
    setOpen(false);
  }

  function openExplorer() {
    if (!address) {
      return;
    }
    window.open(explorerUrl(address, network), "_blank", "noopener,noreferrer");
    setOpen(false);
  }

  function disconnectWallet() {
    logout();
    router.replace("/login");
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-8 items-center gap-2 rounded-full border border-border bg-surface-1 px-3 text-xs font-semibold text-text-primary hover:bg-surface-3"
      >
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface-0">
          <Wallet size={12} />
        </span>
        <span>{shortAddress}</span>
        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-brand-400">
          {network}
        </span>
        <ChevronDown size={13} />
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-56 rounded-xl border border-border bg-surface-1 p-2 shadow-xl">
          <button
            type="button"
            onClick={copyAddress}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-3"
          >
            <Copy size={14} />
            Copy address
          </button>
          <button
            type="button"
            onClick={openExplorer}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-3"
          >
            <ExternalLink size={14} />
            View explorer
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              router.push("/profile");
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-3"
          >
            <RefreshCw size={14} />
            Update wallet
          </button>
          <button
            type="button"
            onClick={disconnectWallet}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[#d02020] hover:bg-[#ffe2e2]"
          >
            <LogOut size={14} />
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}
