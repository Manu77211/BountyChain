"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import { listBountiesRequest, listMyBountiesRequest, meRequest, meStatsRequest } from "../../lib/api";
import { formatAlgo } from "../../lib/algo";
import { useRealtimeChannel } from "../../lib/realtime-client";
import { useAuthStore } from "../../store/auth-store";
import { Button, Card, PageIntro, Pill, ProgressBar, Textarea } from "../../components/ui/primitives";

type DashboardBounty = {
  id: string;
  creator_id?: string;
  title: string;
  status: string;
  total_amount: string;
  deadline: string;
  scoring_mode: string;
};

type DashboardProfile = {
  user?: {
    reputation_score?: number;
    role?: string;
  };
};

type DashboardStats = {
  active_bounties?: number;
  completed_bounties?: number;
  disputed_bounties?: number;
  escrow_total?: string;
  reputation?: number;
};

const CLIENT_MNEMONIC_STORAGE_KEY = "bountychain.client.mnemonic.demo";

function normalizeDashboardError(message: string) {
  const text = message.toLowerCase();
  if (text.includes("database unavailable") || text.includes("cannot reach api server")) {
    return "Backend is unavailable. Start API and verify database connection, then refresh.";
  }
  return message;
}

export default function DashboardPage() {
  const router = useRouter();
  const { token, user, hydrate, logout } = useAuthStore();
  const [bounties, setBounties] = useState<DashboardBounty[]>([]);
  const [profile, setProfile] = useState<DashboardProfile | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mnemonicDraft, setMnemonicDraft] = useState("");
  const [mnemonicNotice, setMnemonicNotice] = useState<string | null>(null);
  const role = String(user?.role ?? profile?.user?.role ?? "").toLowerCase();
  const isClient = role === "client";

  function onLogout() {
    logout();
    router.replace("/login");
  }

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!isClient) {
      return;
    }
    const existingValue = window.sessionStorage.getItem(CLIENT_MNEMONIC_STORAGE_KEY);
    if (existingValue) {
      setMnemonicDraft(existingValue);
      setMnemonicNotice("Loaded your demo mnemonic draft from this browser session.");
    }
  }, [isClient]);

  const loadDashboard = useCallback(async () => {
    if (!token) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const normalizedRole = String(user?.role ?? "").toLowerCase();
      const bountyRequest = normalizedRole === "client"
        ? listMyBountiesRequest(token, { limit: 25 })
        : listBountiesRequest({ status: "open", limit: 25 });

      const [profileData, statsData, bountyList] = await Promise.allSettled([
        meRequest(token),
        meStatsRequest(token),
        bountyRequest,
      ]);

      if (profileData.status === "fulfilled") {
        setProfile(profileData.value as DashboardProfile);
      }
      if (statsData.status === "fulfilled") {
        setStats(statsData.value as DashboardStats);
      }
      if (bountyList.status === "fulfilled") {
        const payload = bountyList.value as { data?: DashboardBounty[] };
        setBounties(payload.data ?? []);
      }

      const failed = [profileData, statsData, bountyList].find((entry) => entry.status === "rejected") as
        | PromiseRejectedResult
        | undefined;
      if (failed) {
        setError(normalizeDashboardError((failed.reason as Error).message));
      }
    } catch (requestError) {
      setError(normalizeDashboardError((requestError as Error).message));
    } finally {
      setLoading(false);
    }
  }, [token, user?.role]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  const realtime = useRealtimeChannel({
    token,
    onEvent: () => {
      void loadDashboard();
    },
  });

  const activeBounties = Number(stats?.active_bounties ?? bounties.filter((item) => item.status === "open" || item.status === "in_progress").length);
  const completedBounties = Number(stats?.completed_bounties ?? bounties.filter((item) => item.status === "completed").length);
  const disputedBounties = Number(stats?.disputed_bounties ?? bounties.filter((item) => item.status === "disputed").length);
  const reputation = Number(stats?.reputation ?? profile?.user?.reputation_score ?? 0);
  const escrowTotal = Number(stats?.escrow_total ?? bounties.reduce((sum, item) => sum + Number(item.total_amount ?? "0"), 0));

  function saveMnemonicDraft() {
    window.sessionStorage.setItem(CLIENT_MNEMONIC_STORAGE_KEY, mnemonicDraft.trim());
    setMnemonicNotice("Saved in this browser session only (demo mode).");
  }

  function clearMnemonicDraft() {
    window.sessionStorage.removeItem(CLIENT_MNEMONIC_STORAGE_KEY);
    setMnemonicDraft("");
    setMnemonicNotice("Cleared session-stored mnemonic draft.");
  }

  return (
    <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="space-y-6">
      <PageIntro
        title={isClient ? "Client Dashboard" : "Freelancer Dashboard"}
        subtitle={
          isClient
            ? "Create and fund bounties, monitor validation stages, and handle disputes in realtime."
            : "Track accepted bounties, CI and scoring status, and payout readiness in realtime."
        }
      />

      {realtime.state === "reconnecting" ? (
        <Card className="p-4">
          <p className="text-sm text-[#8f1515]">Reconnecting to live updates...</p>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="p-5">
          <p className="text-sm text-[#4b4b4b]">Active Bounties</p>
          <p className="mt-2 text-3xl font-semibold">{activeBounties}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-[#4b4b4b]">Funds Tracked</p>
          <p className="mt-2 text-3xl font-semibold">{formatAlgo(escrowTotal, 2)} ALGO</p>
          <p className="mt-1 text-xs text-[#4b4b4b]">1 ALGO = 1,000,000 microALGO</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-[#4b4b4b]">Disputed</p>
          <p className="mt-2 text-3xl font-semibold">{disputedBounties}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-[#4b4b4b]">Reputation</p>
          <p className="mt-2 text-3xl font-semibold">{reputation.toFixed(0)}</p>
          <div className="mt-3">
            <ProgressBar value={Math.min(100, reputation)} />
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Live Bounties</h2>
            <Pill text={realtime.state} />
          </div>
          {loading ? <p className="mt-4 text-[#4b4b4b]">Loading summary...</p> : null}
          {error ? <p className="mt-4 text-sm text-[#8f1515]">{error}</p> : null}
          {!loading && !error ? (
            <div className="mt-4 space-y-3">
              {bounties.slice(0, 6).map((bounty) => {
                const statusProgress = bounty.status === "completed" ? 100 : bounty.status === "disputed" ? 50 : 20;
                return (
                  <div key={bounty.id} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">{bounty.title}</p>
                      <Pill text={bounty.status} />
                    </div>
                    <p className="mt-1 text-xs text-[#4b4b4b]">{new Date(bounty.deadline).toLocaleString()} | {bounty.scoring_mode}</p>
                    <div className="mt-3">
                      <ProgressBar value={statusProgress} />
                    </div>
                    <div className="mt-3 flex gap-2">
                      <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                        <Link href={`/bounties/${bounty.id}`}>View Details</Link>
                      </Button>
                    </div>
                  </div>
                );
              })}
              {bounties.length === 0 ? <p className="text-sm text-[#4b4b4b]">No bounties to show yet.</p> : null}
            </div>
          ) : null}
        </Card>

        <Card>
          <h2 className="text-lg font-semibold">Quick Actions</h2>
          <p className="mt-1 text-sm text-[#4b4b4b]">Navigate directly to the new dashboard routes.</p>
          <div className="mt-4 space-y-3">
            {isClient ? (
              <Button asChild>
                <Link href="/bounties/create">Create Bounty</Link>
              </Button>
            ) : (
              <Button asChild>
                <Link href="/dashboard/projects">Submit Work</Link>
              </Button>
            )}
            {!isClient ? (
              <Button asChild variant="secondary">
                <Link href="/dashboard/freelancers">Browse Marketplace</Link>
              </Button>
            ) : null}
            <Button asChild variant="secondary">
              <Link href="/dashboard/bounties">Browse Bounties</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="/profile">Profile & Wallet</Link>
            </Button>
            <Button variant="secondary" onClick={onLogout}>Logout</Button>
          </div>
        </Card>
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-[#4b4b4b]">Completed Bounties</p>
            <p className="mt-1 text-2xl font-semibold">{completedBounties}</p>
          </div>
          <Button asChild variant="secondary">
            <Link href="/profile">Open Profile</Link>
          </Button>
        </div>
      </Card>

      {isClient ? (
        <Card>
          <h2 className="text-lg font-semibold">Client Demo Mnemonic</h2>
          <p className="mt-1 text-sm text-[#4b4b4b]">
            Demo-only local draft input for transaction scripts. This is not sent to the backend from this screen.
          </p>
          <div className="mt-4 space-y-3">
            <Textarea
              rows={3}
              value={mnemonicDraft}
              onChange={(event) => setMnemonicDraft(event.target.value)}
              placeholder="Paste your 25-word demo mnemonic here"
            />
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={saveMnemonicDraft}>Save Draft</Button>
              <Button type="button" variant="secondary" onClick={clearMnemonicDraft}>Clear Draft</Button>
            </div>
            {mnemonicNotice ? <p className="text-xs text-[#4b4b4b]">{mnemonicNotice}</p> : null}
          </div>
        </Card>
      ) : null}
    </motion.section>
  );
}

