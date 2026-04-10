"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import * as Switch from "@radix-ui/react-switch";
import {
  disconnectSessionRequest,
  listProfileActivitiesRequest,
  listProfilePayoutsRequest,
  getProfileSummaryRequest,
  meRequest,
  updateMeRequest,
} from "../../lib/api";
import { AppShell } from "../../src/components/layout/AppShell";
import { Protected } from "../../components/protected";
import { Button, Card, Input, PageIntro, Pill, Select } from "../../components/ui/primitives";
import { useAuthStore } from "../../store/auth-store";

type MeResponse = {
  user: {
    id: string;
    email: string | null;
    wallet_address: string | null;
    role: string;
    reputation_score: number;
    is_sanctions_flagged: boolean;
    is_banned: boolean;
    created_at: string;
  };
  wallet_linked: boolean;
};

type SummaryResponse = {
  client: {
    bounties_posted: number;
    total_paid_out: string;
    avg_fulfillment_rate: number;
    total_bounties: number;
  };
  freelancer: {
    submissions: number;
    passed: number;
    avg_score: number;
    total_earned: string;
  };
  disputes_count: number;
};

type UpdateMeResponse = {
  user: MeResponse["user"];
};

type ActivityType = "bounties" | "submissions" | "payouts" | "disputes";

type ActivityRow = Record<string, unknown> & {
  id: string;
  created_at?: string;
  raised_at?: string;
  status?: string;
  title?: string;
  bounty_title?: string;
};

type PayoutRow = {
  id: string;
  bounty_id: string;
  bounty_title: string;
  amount: string | null;
  tx_id: string | null;
  status: string;
  created_at: string;
};

type WalletProvider = "pera" | "walletconnect" | "algosigner";

const PROFILE_NOTIFICATION_PREFS_KEY = "bountyescrow.profile.notification-preferences.v1";

function reputationTier(score: number) {
  if (score >= 81) {
    return "Elite";
  }
  if (score >= 61) {
    return "Pro";
  }
  if (score >= 31) {
    return "Verified";
  }
  return "Newcomer";
}

function asAmount(value: string | null | undefined) {
  return Number(value ?? "0") / 1_000_000;
}

function toIsoDateTime(value: string) {
  if (!value) {
    return undefined;
  }
  return new Date(`${value}T00:00:00.000Z`).toISOString();
}

function isSessionExpiredError(detail: string) {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("unauthorized") ||
    normalized.includes("session") ||
    normalized.includes("expired token") ||
    normalized.includes("invalid or expired token")
  );
}

export default function ProfilePage() {
  const { token, logout, hydrate } = useAuthStore();
  const router = useRouter();

  const [profile, setProfile] = useState<MeResponse | null>(null);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [activeActivityTab, setActiveActivityTab] = useState<ActivityType>("bounties");
  const [activities, setActivities] = useState<ActivityRow[]>([]);
  const [payouts, setPayouts] = useState<PayoutRow[]>([]);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [notifyDisputes, setNotifyDisputes] = useState(true);
  const [notifyPayouts, setNotifyPayouts] = useState(true);
  const [notifyBounties, setNotifyBounties] = useState(true);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [sessionDropped, setSessionDropped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<WalletProvider>("pera");
  const [network, setNetwork] = useState(process.env.NEXT_PUBLIC_ALGORAND_NETWORK ?? "testnet");
  const [walletMessage, setWalletMessage] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const stored = window.localStorage.getItem(PROFILE_NOTIFICATION_PREFS_KEY);
      if (!stored) {
        return;
      }

      const parsed = JSON.parse(stored) as {
        notifyDisputes?: boolean;
        notifyPayouts?: boolean;
        notifyBounties?: boolean;
      };

      setNotifyDisputes(Boolean(parsed.notifyDisputes));
      setNotifyPayouts(Boolean(parsed.notifyPayouts));
      setNotifyBounties(Boolean(parsed.notifyBounties));
    } catch {
      window.localStorage.removeItem(PROFILE_NOTIFICATION_PREFS_KEY);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      PROFILE_NOTIFICATION_PREFS_KEY,
      JSON.stringify({
        notifyDisputes,
        notifyPayouts,
        notifyBounties,
      }),
    );
  }, [notifyBounties, notifyDisputes, notifyPayouts]);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const loadOverview = useCallback(async () => {
    if (!token) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [profileResponse, summaryResponse] = await Promise.all([
        meRequest(token) as Promise<MeResponse>,
        getProfileSummaryRequest(token) as Promise<SummaryResponse>,
      ]);
      setProfile(profileResponse);
      setSummary(summaryResponse);
      setEmail(profileResponse.user.email ?? "");
      setSessionDropped(false);
    } catch (requestError) {
      const detail = (requestError as Error).message;
      setError(detail);
      if (isSessionExpiredError(detail)) {
        setSessionDropped(true);
        logout();
        router.replace("/login");
      }
    } finally {
      setLoading(false);
    }
  }, [token, logout, router]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const loadActivity = useCallback(async () => {
    if (!token) {
      return;
    }

    try {
      const response = (await listProfileActivitiesRequest(token, {
        type: activeActivityTab,
        page: 1,
        page_size: 8,
        from: toIsoDateTime(fromDate),
        to: toIsoDateTime(toDate),
      })) as { data?: ActivityRow[] };

      setActivities(response.data ?? []);
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }, [activeActivityTab, fromDate, toDate, token]);

  const loadPayouts = useCallback(async () => {
    if (!token) {
      return;
    }

    try {
      const response = (await listProfilePayoutsRequest(token, {
        page: 1,
        page_size: 20,
        from: toIsoDateTime(fromDate),
        to: toIsoDateTime(toDate),
      })) as { data?: PayoutRow[] };

      setPayouts(response.data ?? []);
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }, [fromDate, toDate, token]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  useEffect(() => {
    void loadPayouts();
  }, [loadPayouts]);

  const networkMismatch = useMemo(() => {
    const required = (process.env.NEXT_PUBLIC_ALGORAND_NETWORK ?? "testnet").toLowerCase();
    return network.toLowerCase() !== required;
  }, [network]);

  async function onSaveEmail() {
    if (!token) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response = (await updateMeRequest(token, {
        email: email.trim() || undefined,
      })) as UpdateMeResponse;

      setProfile((current) => {
        if (!current) {
          return {
            user: response.user,
            wallet_linked: Boolean(response.user.wallet_address),
          };
        }

        return {
          ...current,
          user: response.user,
          wallet_linked: Boolean(response.user.wallet_address),
        };
      });
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function onConnectWallet() {
    if (selectedProvider === "algosigner") {
      const hasAlgoSigner = typeof window !== "undefined" && Boolean((window as unknown as { AlgoSigner?: unknown }).AlgoSigner);
      if (!hasAlgoSigner) {
        setWalletMessage("AlgoSigner extension not found. Install it or switch provider.");
        return;
      }
    }

    if (networkMismatch) {
      setWalletMessage("Selected network does not match app network. Switch to the configured network first.");
      return;
    }

    setWalletMessage(
      "Wallet provider selected. Complete wallet-login flow to issue a fresh auth session when needed.",
    );
  }

  async function onDisconnectSession() {
    setDisconnecting(true);
    setError(null);

    try {
      await disconnectSessionRequest();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      logout();
      setDisconnecting(false);
      router.replace("/login");
    }
  }

  function onCopyWallet() {
    const wallet = profile?.user.wallet_address;
    if (!wallet) {
      return;
    }

    void navigator.clipboard.writeText(wallet);
    setWalletMessage("Wallet address copied.");
  }

  function onExportPayoutCsv() {
    if (payouts.length === 0) {
      setWalletMessage("No payouts to export for current filter.");
      return;
    }

    const header = ["id", "bounty_id", "bounty_title", "amount_algo", "tx_id", "status", "created_at"];
    const rows = payouts.map((row) => [
      row.id,
      row.bounty_id,
      row.bounty_title,
      String(asAmount(row.amount)),
      row.tx_id ?? "",
      row.status,
      row.created_at,
    ]);
    const csv = [header, ...rows]
      .map((line) => line.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `payouts-${Date.now()}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  const tier = reputationTier(profile?.user.reputation_score ?? 0);
  const walletExplorerLink = profile?.user.wallet_address
    ? `https://testnet.algoexplorer.io/address/${profile.user.wallet_address}`
    : null;

  return (
    <Protected>
      <AppShell>
        <section className="space-y-6">
          <PageIntro
            title="Profile"
            subtitle="Manage identity, wallet setup, activity history, payouts, and notifications."
          />

          {sessionDropped ? (
            <Card>
              <p className="text-sm text-[#8f1515]">Authentication session dropped. Reconnect wallet and sign in again.</p>
              <Button className="mt-3" onClick={() => router.replace("/login")}>Go to Login</Button>
            </Card>
          ) : null}

          {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}
          {loading ? <p className="text-sm text-[#4b4b4b]">Loading profile...</p> : null}

          {profile ? (
            <>
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-3">
                      <div className="flex h-20 w-20 items-center justify-center rounded-full border-2 border-[#121212] bg-[#f0c020] text-2xl font-black">
                        {profile.user.wallet_address?.slice(0, 2) ?? "U"}
                      </div>
                      <div>
                        <h2 className="text-xl font-semibold">User {profile.user.id.slice(0, 8)}</h2>
                        <p className="text-sm text-[#4b4b4b]">Member since {new Date(profile.user.created_at).toLocaleDateString()}</p>
                      </div>
                    </div>
                    <p className="mt-2 text-sm text-[#4b4b4b]">Wallet {profile.user.wallet_address ?? "not linked"}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button variant="secondary" className="h-8 px-3 text-xs" onClick={onCopyWallet}>Copy Wallet</Button>
                      {walletExplorerLink ? (
                        <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                          <a href={walletExplorerLink} target="_blank" rel="noreferrer">View Explorer</a>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Pill text={profile.user.role} />
                    <Pill text={`Reputation ${profile.user.reputation_score}`} />
                    <Pill text={tier} />
                  </div>
                </div>
                <p className="mt-3 text-xs text-[#4b4b4b]" title="How is this calculated? The tier is based on your reputation score and historical delivery quality.">
                  Tier policy: Newcomer 0-30, Verified 31-60, Pro 61-80, Elite 81-100.
                </p>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-sm font-semibold">Email</label>
                    <Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@domain.com" />
                  </div>
                  <div className="flex items-end">
                    <Button onClick={() => void onSaveEmail()} disabled={saving}>
                      {saving ? "Saving..." : "Save Profile"}
                    </Button>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2 text-xs">
                  {profile.user.is_banned ? <Pill text="banned" /> : null}
                  {profile.user.is_sanctions_flagged ? <Pill text="sanctions flagged" /> : null}
                </div>
              </Card>

              <div className="grid gap-3 md:grid-cols-4">
                <Card>
                  <p className="text-xs text-[#4b4b4b]">Bounties Posted</p>
                  <p className="mt-1 text-2xl font-black">{summary?.client.bounties_posted ?? 0}</p>
                </Card>
                <Card>
                  <p className="text-xs text-[#4b4b4b]">Fulfillment Rate</p>
                  <p className="mt-1 text-2xl font-black">{summary?.client.avg_fulfillment_rate ?? 0}%</p>
                </Card>
                <Card>
                  <p className="text-xs text-[#4b4b4b]">Avg Submission Score</p>
                  <p className="mt-1 text-2xl font-black">{Number(summary?.freelancer.avg_score ?? 0).toFixed(1)}</p>
                </Card>
                <Card>
                  <p className="text-xs text-[#4b4b4b]">Total Disputes</p>
                  <p className="mt-1 text-2xl font-black">{summary?.disputes_count ?? 0}</p>
                </Card>
              </div>

              <Card>
                <h3 className="text-lg font-semibold">Wallet Provider</h3>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-sm font-semibold">Provider</label>
                    <Select value={selectedProvider} onChange={(event) => setSelectedProvider(event.target.value as WalletProvider)}>
                      <option value="pera">Pera Wallet</option>
                      <option value="walletconnect">WalletConnect</option>
                      <option value="algosigner">AlgoSigner</option>
                    </Select>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-semibold">Network</label>
                    <Select value={network} onChange={(event) => setNetwork(event.target.value)}>
                      <option value="testnet">testnet</option>
                      <option value="mainnet">mainnet</option>
                    </Select>
                  </div>
                </div>
                {networkMismatch ? (
                  <p className="mt-3 text-sm text-[#8f1515]">Network mismatch detected for selected wallet provider.</p>
                ) : null}
                <p className="mt-2 border border-[#be8b00] bg-[#fff4d6] p-2 text-sm text-[#7a5a00]">
                  Auth-003: Changing wallet will require re-authentication.
                </p>
                {profile.user.is_sanctions_flagged ? (
                  <p className="mt-3 border border-[#be8b00] bg-[#fff4d6] p-2 text-sm text-[#7a5a00]">
                    Wallet is sanctions-flagged. Transactions and payouts may be blocked until review is complete.
                  </p>
                ) : null}
                {walletMessage ? <p className="mt-3 text-sm text-[#4b4b4b]">{walletMessage}</p> : null}
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button onClick={onConnectWallet}>Connect Provider</Button>
                  <Button variant="secondary" onClick={() => void onDisconnectSession()} disabled={disconnecting}>
                    {disconnecting ? "Disconnecting..." : "Disconnect Session"}
                  </Button>
                </div>
              </Card>

              <Card>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant={activeActivityTab === "bounties" ? "primary" : "secondary"}
                    onClick={() => setActiveActivityTab("bounties")}
                  >
                    Bounties
                  </Button>
                  <Button
                    variant={activeActivityTab === "submissions" ? "primary" : "secondary"}
                    onClick={() => setActiveActivityTab("submissions")}
                  >
                    Submissions
                  </Button>
                  <Button
                    variant={activeActivityTab === "payouts" ? "primary" : "secondary"}
                    onClick={() => setActiveActivityTab("payouts")}
                  >
                    Payouts
                  </Button>
                  <Button
                    variant={activeActivityTab === "disputes" ? "primary" : "secondary"}
                    onClick={() => setActiveActivityTab("disputes")}
                  >
                    Disputes
                  </Button>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-4">
                  <div>
                    <label className="mb-1 block text-xs font-semibold">From</label>
                    <Input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold">To</label>
                    <Input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
                  </div>
                  <div className="sm:col-span-2 flex items-end gap-2">
                    <Button variant="secondary" onClick={() => void loadActivity()}>Apply Activity Filter</Button>
                    <Button variant="secondary" onClick={() => void loadPayouts()}>Apply Payout Filter</Button>
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  {activities.map((item) => (
                    <div key={item.id} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                      <p className="text-sm font-semibold">{String(item.title ?? item.bounty_title ?? item.id)}</p>
                      <p className="text-xs text-[#4b4b4b]">Status: {String(item.status ?? "n/a")}</p>
                      <p className="text-xs text-[#4b4b4b]">
                        {new Date(String(item.created_at ?? item.raised_at ?? Date.now())).toLocaleString()}
                      </p>
                    </div>
                  ))}
                  {activities.length === 0 ? <p className="text-sm text-[#4b4b4b]">No activity rows for this tab.</p> : null}
                </div>
              </Card>

              <Card>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold">Payout History</h3>
                  <Button variant="secondary" className="ml-auto" onClick={onExportPayoutCsv}>Export CSV</Button>
                </div>

                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-[#d8d8d8] text-xs uppercase tracking-wide text-[#4b4b4b]">
                        <th className="py-2 pr-4">Bounty</th>
                        <th className="py-2 pr-4">Amount</th>
                        <th className="py-2 pr-4">Status</th>
                        <th className="py-2 pr-4">Tx</th>
                        <th className="py-2">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payouts.map((item) => (
                        <tr key={item.id} className="border-b border-[#ececec]">
                          <td className="py-3 pr-4">{item.bounty_title}</td>
                          <td className="py-3 pr-4">{asAmount(item.amount).toFixed(6)} ALGO</td>
                          <td className="py-3 pr-4">{item.status}</td>
                          <td className="py-3 pr-4">{item.tx_id ? item.tx_id.slice(0, 14) : "-"}</td>
                          <td className="py-3">{new Date(item.created_at).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {payouts.length === 0 ? <p className="mt-2 text-sm text-[#4b4b4b]">No payouts for selected filter.</p> : null}
                </div>
              </Card>

              <Card>
                <h3 className="text-lg font-semibold">Notification Preferences</h3>
                <div className="mt-3 space-y-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span>Email on dispute updates</span>
                    <Switch.Root
                      checked={notifyDisputes}
                      onCheckedChange={setNotifyDisputes}
                      className="relative h-6 w-11 border border-[#121212] bg-white data-[state=checked]:bg-[#1040c0]"
                    >
                      <Switch.Thumb className="block h-5 w-5 translate-x-0.5 bg-[#121212] transition-transform data-[state=checked]:translate-x-[22px] data-[state=checked]:bg-white" />
                    </Switch.Root>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Email on payout</span>
                    <Switch.Root
                      checked={notifyPayouts}
                      onCheckedChange={setNotifyPayouts}
                      className="relative h-6 w-11 border border-[#121212] bg-white data-[state=checked]:bg-[#1040c0]"
                    >
                      <Switch.Thumb className="block h-5 w-5 translate-x-0.5 bg-[#121212] transition-transform data-[state=checked]:translate-x-[22px] data-[state=checked]:bg-white" />
                    </Switch.Root>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Email on bounty events</span>
                    <Switch.Root
                      checked={notifyBounties}
                      onCheckedChange={setNotifyBounties}
                      className="relative h-6 w-11 border border-[#121212] bg-white data-[state=checked]:bg-[#1040c0]"
                    >
                      <Switch.Thumb className="block h-5 w-5 translate-x-0.5 bg-[#121212] transition-transform data-[state=checked]:translate-x-[22px] data-[state=checked]:bg-white" />
                    </Switch.Root>
                  </div>
                  <div className="flex items-center justify-between gap-3 opacity-60">
                    <span>In-app notifications (always on)</span>
                    <Switch.Root
                      checked
                      disabled
                      className="relative h-6 w-11 border border-[#121212] bg-[#1040c0]"
                    >
                      <Switch.Thumb className="block h-5 w-5 translate-x-[22px] bg-white" />
                    </Switch.Root>
                  </div>
                </div>
                <p className="mt-3 text-xs text-[#4b4b4b]">Preferences are currently stored on this device session.</p>
              </Card>
            </>
          ) : null}
        </section>
      </AppShell>
    </Protected>
  );
}
