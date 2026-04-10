"use client";

import Link from "next/link";
import { useMemo } from "react";
import { CheckCircle2, Loader2, ShieldCheck, Wallet, Zap, PlugZap, AlertTriangle } from "lucide-react";
import { useWallet } from "../../src/hooks/useWallet";

export const dynamic = "force-dynamic";

function isAlgoSignerInstalled() {
  if (typeof window === "undefined") {
    return false;
  }
  return Boolean((window as unknown as { AlgoSigner?: unknown }).AlgoSigner);
}

export default function ConnectPage() {
  const {
    connectPera,
    connectWalletConnect,
    connectAlgoSigner,
    is_connecting,
    status,
    selectedWallet,
    error,
    network,
  } = useWallet();

  const algoSignerInstalled = isAlgoSignerInstalled();

  const warning = useMemo(() => {
    if (error?.includes("SC-C-006") || network === "testnet") {
      return "Your wallet is on TestNet. Please switch to MainNet to continue.";
    }
    return null;
  }, [error, network]);

  const uiStateText = useMemo(() => {
    if (status === "connecting") {
      return `Connecting to ${selectedWallet ?? "wallet"}...`;
    }
    if (status === "signing") {
      return "Check your wallet to approve the signature request";
    }
    if (status === "success") {
      return "Connected! Redirecting...";
    }
    if (status === "error") {
      return "Connection failed. Please try again.";
    }
    return "Choose your Algorand wallet to continue";
  }, [selectedWallet, status]);

  return (
    <main
      className="min-h-screen bg-surface-0"
      style={{
        backgroundImage:
          "repeating-linear-gradient(0deg, rgba(18,18,18,0.03) 0px, rgba(18,18,18,0.03) 1px, transparent 1px, transparent 28px), repeating-linear-gradient(90deg, rgba(18,18,18,0.03) 0px, rgba(18,18,18,0.03) 1px, transparent 1px, transparent 28px)",
      }}
    >
      <div className="grid min-h-screen md:grid-cols-[40%_60%]">
        <section className="relative hidden border-r border-border bg-surface-1 p-10 md:flex md:flex-col md:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-0 px-3 py-1 text-sm font-black uppercase tracking-wide text-text-primary">
              BountyEscrow <span className="rounded-full bg-[var(--algo)] px-2 py-0.5 text-[10px]">AI</span>
            </div>

            <h1 className="mt-8 max-w-md text-4xl font-black leading-tight text-text-primary">
              Decentralized bounties.
              <br />
              Automated trust.
            </h1>

            <div className="mt-8 space-y-4">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 text-[var(--algo)]" size={18} />
                <p className="text-sm text-text-primary">Funds locked on Algorand blockchain</p>
              </div>
              <div className="flex items-start gap-3">
                <Zap className="mt-0.5 text-[var(--algo)]" size={18} />
                <p className="text-sm text-text-primary">Auto-release via AI + CI/CD validation</p>
              </div>
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 text-[var(--algo)]" size={18} />
                <p className="text-sm text-text-primary">No intermediary. No fraud. No delays.</p>
              </div>
            </div>
          </div>

          <p className="pointer-events-none select-none text-7xl font-black uppercase tracking-tight text-text-tertiary/20">
            Algorand
          </p>
        </section>

        <section className="flex items-center justify-center p-6 md:p-10">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-surface-1 p-6 shadow-2xl">
            <h2 className="text-2xl font-black text-text-primary">Connect your wallet</h2>
            <p className="mt-1 text-sm text-text-tertiary">{uiStateText}</p>

            {warning ? (
              <div className="mt-4 rounded-xl border border-[#e0a800] bg-[#fff4d1] p-3 text-sm text-[#7a5400]">
                <p>{warning}</p>
                <Link className="mt-1 inline-block text-xs font-semibold underline" href="https://support.perawallet.app/en/article/changing-networks-mainnet-testnet-18d5s6k/" target="_blank">
                  Switch network instructions
                </Link>
              </div>
            ) : null}

            {error ? (
              <div className="mt-4 rounded-xl border border-[#d02020] bg-[#ffe2e2] p-3 text-sm text-[#8f1515]">
                <p>{error}</p>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="mt-2 text-xs font-semibold underline"
                >
                  Try again
                </button>
              </div>
            ) : null}

            <div className="mt-5 space-y-3">
              <button
                type="button"
                onClick={() => void connectPera()}
                disabled={is_connecting}
                className="flex w-full items-center justify-between rounded-xl border border-border bg-surface-0 px-4 py-3 text-left hover:bg-surface-3 disabled:opacity-70"
              >
                <span className="flex items-center gap-3">
                  <Wallet size={16} />
                  <span className="text-sm font-semibold text-text-primary">Pera Wallet</span>
                </span>
                <span className="rounded-full border border-border bg-[#f0c020] px-2 py-0.5 text-[10px] font-bold uppercase">Most Popular</span>
              </button>

              <button
                type="button"
                onClick={() => void connectWalletConnect()}
                disabled={is_connecting}
                className="flex w-full items-center justify-between rounded-xl border border-border bg-surface-0 px-4 py-3 text-left hover:bg-surface-3 disabled:opacity-70"
              >
                <span className="flex items-center gap-3">
                  <PlugZap size={16} />
                  <span className="text-sm font-semibold text-text-primary">WalletConnect</span>
                </span>
                {selectedWallet === "WalletConnect" && is_connecting ? <Loader2 size={14} className="animate-spin" /> : null}
              </button>

              <button
                type="button"
                onClick={() => void connectAlgoSigner()}
                disabled={is_connecting || !algoSignerInstalled}
                className="flex w-full items-center justify-between rounded-xl border border-border bg-surface-0 px-4 py-3 text-left hover:bg-surface-3 disabled:opacity-70"
              >
                <span className="flex items-center gap-3">
                  <ShieldCheck size={16} />
                  <span className="text-sm font-semibold text-text-primary">AlgoSigner</span>
                </span>
                {!algoSignerInstalled ? (
                  <Link
                    href="https://www.purestake.com/technology/algosigner/"
                    target="_blank"
                    onClick={(event) => event.stopPropagation()}
                    className="text-xs font-semibold underline"
                  >
                    Install Extension
                  </Link>
                ) : null}
              </button>
            </div>

            {status === "signing" ? (
              <div className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-surface-0 px-3 py-2 text-sm text-text-primary">
                <Loader2 size={14} className="animate-spin" />
                <span>Awaiting wallet signature approval</span>
              </div>
            ) : null}

            {status === "success" ? (
              <div className="mt-4 flex items-center gap-2 rounded-xl border border-[#0f7b44] bg-[#e8fff2] px-3 py-2 text-sm text-[#0f7b44]">
                <CheckCircle2 size={15} />
                <span>Connected! Redirecting...</span>
              </div>
            ) : null}

            {status === "error" && !error ? (
              <div className="mt-4 flex items-center gap-2 rounded-xl border border-[#d02020] bg-[#ffe2e2] px-3 py-2 text-sm text-[#8f1515]">
                <AlertTriangle size={15} />
                <span>Unable to connect wallet. Please retry.</span>
              </div>
            ) : null}

            <p className="mt-6 text-xs leading-relaxed text-text-tertiary">
              By connecting, you agree to our Terms of Service. Your wallet is never stored by us - only your public address.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
