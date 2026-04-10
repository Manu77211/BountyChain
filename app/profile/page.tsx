"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  disconnectSessionRequest,
  getProfileSummaryRequest,
  meRequest,
  meStatsRequest,
  updateMeRequest,
} from "../../lib/api";
import { connectPeraWallet } from "../../lib/pera-wallet";
import { AppShell } from "../../src/components/layout/AppShell";
import { Protected } from "../../components/protected";
import { Button, Card, Input, PageIntro, Pill } from "../../components/ui/primitives";
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

type ProfileStatsResponse = {
  wallet_balance_algo?: number;
  wallet_balance_available?: boolean;
};

type UpdateMeResponse = {
  user: MeResponse["user"];
};

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

function microToAlgo(value: string | null | undefined) {
  return (Number(value ?? "0") / 1_000_000).toFixed(6);
}

function maskWallet(wallet: string | null | undefined) {
  if (!wallet) {
    return "Not linked";
  }
  if (wallet.length <= 12) {
    return wallet;
  }
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

function displayName(email: string | null | undefined, role: string) {
  if (email && email.includes("@")) {
    return email.split("@")[0];
  }
  const normalizedRole = role.toUpperCase();
  return normalizedRole === "CLIENT" ? "Client" : "Freelancer";
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
  const [email, setEmail] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [showWallet, setShowWallet] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connectingPera, setConnectingPera] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [sessionDropped, setSessionDropped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [walletMessage, setWalletMessage] = useState<string | null>(null);
  const [walletBalanceAlgo, setWalletBalanceAlgo] = useState(0);
  const [walletBalanceAvailable, setWalletBalanceAvailable] = useState(true);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const refreshWalletBalance = useCallback(async () => {
    if (!token) {
      return;
    }

    try {
      const stats = (await meStatsRequest(token)) as ProfileStatsResponse;
      setWalletBalanceAlgo(Number(stats.wallet_balance_algo ?? 0));
      setWalletBalanceAvailable(stats.wallet_balance_available !== false);
    } catch {
      setWalletBalanceAvailable(false);
    }
  }, [token]);

  const loadOverview = useCallback(async () => {
    if (!token) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [profileResponse, summaryResponse, statsResponse] = await Promise.all([
        meRequest(token) as Promise<MeResponse>,
        getProfileSummaryRequest(token) as Promise<SummaryResponse>,
        meStatsRequest(token) as Promise<ProfileStatsResponse>,
      ]);
      setProfile(profileResponse);
      setSummary(summaryResponse);
      setWalletBalanceAlgo(Number(statsResponse.wallet_balance_algo ?? 0));
      setWalletBalanceAvailable(statsResponse.wallet_balance_available !== false);
      setEmail(profileResponse.user.email ?? "");
      setWalletAddress(profileResponse.user.wallet_address ?? "");
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

  async function onSaveProfile() {
    if (!token) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = (await updateMeRequest(token, {
        email: email.trim() || undefined,
        wallet_address: walletAddress.trim() || undefined,
      })) as UpdateMeResponse;

      setEmail(response.user.email ?? "");
      setWalletAddress(response.user.wallet_address ?? "");

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

      await refreshWalletBalance();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onConnectPera() {
    if (!token) {
      return;
    }

    setConnectingPera(true);
    setWalletMessage("Connecting to Pera Wallet...");
    setError(null);

    try {
      const connectedAddress = await connectPeraWallet();
      const response = (await updateMeRequest(token, {
        wallet_address: connectedAddress,
      })) as UpdateMeResponse;

      setWalletAddress(response.user.wallet_address ?? connectedAddress);
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

      await refreshWalletBalance();
      setWalletMessage("Wallet provider selected. Manual wallet address saved in profile is used for account balance and explorer links.");
    } catch (requestError) {
      setWalletMessage((requestError as Error).message || "Unable to connect Pera wallet.");
    } finally {
      setConnectingPera(false);
    }
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

  const role = String(profile?.user.role ?? "").toUpperCase();
  const tier = reputationTier(profile?.user.reputation_score ?? 0);

  const statCards = useMemo(() => {
    if (role === "CLIENT") {
      return [
        { label: "Bounties Posted", value: String(summary?.client.bounties_posted ?? 0) },
        { label: "Fulfillment Rate", value: `${summary?.client.avg_fulfillment_rate ?? 0}%` },
        { label: "Total Paid Out", value: `${microToAlgo(summary?.client.total_paid_out)} ALGO` },
        { label: "Disputes", value: String(summary?.disputes_count ?? 0) },
      ];
    }

    return [
      { label: "Submissions", value: String(summary?.freelancer.submissions ?? 0) },
      { label: "Passed", value: String(summary?.freelancer.passed ?? 0) },
      { label: "Average Score", value: Number(summary?.freelancer.avg_score ?? 0).toFixed(1) },
      { label: "Total Earned", value: `${microToAlgo(summary?.freelancer.total_earned)} ALGO` },
    ];
  }, [role, summary]);

  return (
    <Protected>
      <AppShell>
        <section className="space-y-6">
          <PageIntro
            title="Profile"
            subtitle={
              role === "CLIENT"
                ? "Client profile with posting and payout metrics."
                : "Freelancer profile with delivery and earning metrics."
            }
          />

          {sessionDropped ? (
            <Card>
              <p className="text-sm text-[#8f1515]">Authentication session dropped. Please sign in again.</p>
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
                    <h2 className="text-xl font-semibold">{displayName(profile.user.email, role)}</h2>
                    <p className="mt-1 text-sm text-[#4b4b4b]">
                      {role === "CLIENT" ? "Client account" : "Freelancer account"} | Member since {new Date(profile.user.created_at).toLocaleDateString()}
                    </p>
                    <p className="mt-2 text-sm text-[#4b4b4b]">
                      Wallet: {showWallet ? (walletAddress || profile.user.wallet_address || "Not linked") : maskWallet(walletAddress || profile.user.wallet_address)}
                    </p>
                    <p className="mt-1 text-sm text-[#4b4b4b]">Wallet Balance: {walletBalanceAlgo.toFixed(6)} ALGO</p>
                    {!walletBalanceAvailable ? <p className="mt-1 text-xs text-[#8f1515]">Unable to fetch live wallet balance right now.</p> : null}
                    {walletMessage ? <p className="mt-1 text-xs text-[#4b4b4b]">{walletMessage}</p> : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Pill text={role || "USER"} />
                    <Pill text={`Reputation ${profile.user.reputation_score}`} />
                    <Pill text={tier} />
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-sm font-semibold">Email</label>
                    <Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@domain.com" />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-semibold">Wallet Address</label>
                    <Input
                      value={walletAddress}
                      onChange={(event) => setWalletAddress(event.target.value)}
                      placeholder="Paste Algorand wallet address"
                    />
                  </div>
                  <div className="flex flex-wrap items-end gap-2 md:col-span-2">
                    <Button onClick={() => void onSaveProfile()} disabled={saving}>
                      {saving ? "Saving..." : "Save Profile"}
                    </Button>
                    <Button variant="secondary" onClick={() => setShowWallet((current) => !current)}>
                      {showWallet ? "Hide Wallet" : "Show Wallet"}
                    </Button>
                    <Button variant="secondary" onClick={() => void onConnectPera()} disabled={connectingPera}>
                      {connectingPera ? "Connecting..." : "Connect Pera"}
                    </Button>
                    <Button variant="secondary" onClick={() => void onDisconnectSession()} disabled={disconnecting}>
                      {disconnecting ? "Disconnecting..." : "Disconnect Session"}
                    </Button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  {profile.user.is_banned ? <Pill text="banned" /> : null}
                  {profile.user.is_sanctions_flagged ? <Pill text="sanctions flagged" /> : null}
                </div>
              </Card>

              <div className="grid gap-3 md:grid-cols-4">
                {statCards.map((card) => (
                  <Card key={card.label}>
                    <p className="text-xs text-[#4b4b4b]">{card.label}</p>
                    <p className="mt-1 text-2xl font-black">{card.value}</p>
                  </Card>
                ))}
              </div>
            </>
          ) : null}
        </section>
      </AppShell>
    </Protected>
  );
}
