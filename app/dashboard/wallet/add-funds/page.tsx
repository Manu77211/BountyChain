"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { meStatsRequest, setMockWalletBalanceRequest } from "../../../../lib/api";
import { useAuthStore } from "../../../../store/auth-store";
import { Button, Card, Input, PageIntro } from "../../../../components/ui/primitives";

type WalletStats = {
  wallet_balance_algo?: number;
  wallet_balance_microalgo?: string;
  wallet_balance_network?: string;
  wallet_mock_mode?: boolean;
};

export default function WalletAddFundsPage() {
  const { token, hydrate } = useAuthStore();
  const [amountAlgo, setAmountAlgo] = useState("1000");
  const [currentAlgo, setCurrentAlgo] = useState(0);
  const [currentMicroAlgo, setCurrentMicroAlgo] = useState("0");
  const [network, setNetwork] = useState("testnet");
  const [mockMode, setMockMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    async function load() {
      if (!token) {
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const stats = (await meStatsRequest(token)) as WalletStats;
        setCurrentAlgo(Number(stats.wallet_balance_algo ?? 0));
        setCurrentMicroAlgo(String(stats.wallet_balance_microalgo ?? "0"));
        setNetwork(String(stats.wallet_balance_network ?? "testnet"));
        setMockMode(Boolean(stats.wallet_mock_mode));
      } catch (requestError) {
        setError((requestError as Error).message);
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [token]);

  async function applyMockFunds() {
    if (!token) {
      setError("Please sign in first.");
      return;
    }

    const parsed = Number(amountAlgo);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setError("Enter a valid ALGO amount.");
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await setMockWalletBalanceRequest(token, parsed);
      const stats = (await meStatsRequest(token)) as WalletStats;
      setCurrentAlgo(Number(stats.wallet_balance_algo ?? 0));
      setCurrentMicroAlgo(String(stats.wallet_balance_microalgo ?? "0"));
      setNetwork(String(stats.wallet_balance_network ?? "testnet"));
      setMockMode(Boolean(stats.wallet_mock_mode));
      setMessage("Mock wallet balance updated.");
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-6">
      <PageIntro title="Add Funds" subtitle="Use mock funding in development or use faucet links for real TestNet funds." />

      <Card className="space-y-3">
        {loading ? <p className="text-sm text-[#4b4b4b]">Loading wallet status...</p> : null}
        {!loading ? <p className="text-sm text-[#4b4b4b]">Network: {network.toUpperCase()}</p> : null}
        {!loading ? <p className="text-sm text-[#4b4b4b]">Current balance: {currentAlgo.toFixed(6)} ALGO ({currentMicroAlgo} microALGO)</p> : null}
        {!loading ? <p className="text-sm text-[#4b4b4b]">Mock mode: {mockMode ? "enabled" : "disabled"}</p> : null}

        {mockMode ? (
          <>
            <div>
              <label className="mb-1 block text-sm font-semibold">Set mock balance (ALGO)</label>
              <Input
                type="number"
                min={0}
                step={0.1}
                value={amountAlgo}
                onChange={(event) => setAmountAlgo(event.target.value)}
              />
            </div>
            <Button type="button" variant="primary" onClick={() => void applyMockFunds()} disabled={saving}>
              {saving ? "Applying..." : "Apply Mock Funds"}
            </Button>
          </>
        ) : (
          <p className="text-sm text-[#7a5a00]">
            Mock balance endpoint is disabled. Set ALGOD_MOCK_MODE=true to use mock funds.
          </p>
        )}

        {message ? <p className="text-sm text-[#1b7b30]">{message}</p> : null}
        {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}
      </Card>

      <Card className="space-y-3">
        <p className="text-sm font-semibold">Real TestNet Funding</p>
        <p className="text-sm text-[#4b4b4b]">Mock coins are local to this app and are not real on-chain transactions.</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary">
            <a href="https://bank.testnet.algorand.network/" target="_blank" rel="noreferrer">Open TestNet Faucet</a>
          </Button>
          <Button asChild variant="secondary">
            <a href="https://testnet.algoexplorer.io/" target="_blank" rel="noreferrer">Open AlgoExplorer</a>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/dashboard/wallet">Back to Wallet</Link>
          </Button>
        </div>
      </Card>
    </section>
  );
}
