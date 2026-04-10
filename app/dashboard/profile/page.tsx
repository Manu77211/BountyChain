"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { disconnectSessionRequest, meRequest, updateMeRequest } from "../../../lib/api";
import { Button, Card, Input, PageIntro, Pill, Select } from "../../../components/ui/primitives";
import { useAuthStore } from "../../../store/auth-store";

type ProfileResponse = {
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

type UpdateProfileResponse = {
  user: ProfileResponse["user"];
};

type WalletProvider = "pera" | "walletconnect" | "algosigner";

function isSessionExpiredError(detail: string) {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("unauthorized") ||
    normalized.includes("session") ||
    normalized.includes("expired token") ||
    normalized.includes("invalid or expired token")
  );
}

export default function DashboardProfilePage() {
  const { token, logout, hydrate } = useAuthStore();
  const router = useRouter();

  const [profile, setProfile] = useState<ProfileResponse | null>(null);
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
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    async function load() {
      if (!token) {
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = (await meRequest(token)) as ProfileResponse;
        setProfile(response);
        setEmail(response.user.email ?? "");
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
    }

    void load();
  }, [token, logout, router]);

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
      })) as UpdateProfileResponse;

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

    setWalletMessage("Wallet provider selected. Complete wallet-login flow to issue a fresh auth session when needed.");
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

  return (
    <section className="space-y-6">
      <PageIntro
        title="Profile & Wallet"
        subtitle="Manage identity, wallet provider preference, and session recovery behavior."
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
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">User {profile.user.id.slice(0, 8)}</h2>
                <p className="text-sm text-[#4b4b4b]">Wallet {profile.user.wallet_address ?? "not linked"}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Pill text={profile.user.role} />
                <Pill text={`Reputation ${profile.user.reputation_score}`} />
              </div>
            </div>
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
            {walletMessage ? <p className="mt-3 text-sm text-[#4b4b4b]">{walletMessage}</p> : null}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={onConnectWallet}>Connect Provider</Button>
              <Button variant="secondary" onClick={() => void onDisconnectSession()} disabled={disconnecting}>
                {disconnecting ? "Disconnecting..." : "Disconnect Session"}
              </Button>
            </div>
          </Card>
        </>
      ) : null}
    </section>
  );
}
