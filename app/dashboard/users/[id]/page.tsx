"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getPublicUserProfileRequest } from "../../../../lib/api";
import { useAuthStore } from "../../../../store/auth-store";
import { Button, Card, PageIntro, Pill } from "../../../../components/ui/primitives";

type PublicUserProfile = {
  user: {
    id: string;
    name: string;
    role: "CLIENT" | "FREELANCER" | "ADMIN";
    wallet_address: string | null;
    reputation_score: number;
    created_at: string;
  };
};

function shortWallet(value: string | null) {
  if (!value) {
    return "Not linked";
  }
  if (value.length <= 16) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

export default function DashboardUserProfilePage() {
  const params = useParams<{ id: string }>();
  const userId = params.id;
  const { token, hydrate } = useAuthStore();

  const [profile, setProfile] = useState<PublicUserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    async function loadProfile() {
      if (!token || !userId) {
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const data = (await getPublicUserProfileRequest(token, userId)) as PublicUserProfile;
        setProfile(data);
      } catch (requestError) {
        setError((requestError as Error).message);
      } finally {
        setLoading(false);
      }
    }

    void loadProfile();
  }, [token, userId]);

  return (
    <section className="space-y-6">
      <PageIntro
        title="Conversation Profile"
        subtitle="Public profile details for chat participants."
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button asChild variant="secondary" className="h-8 px-3 text-xs">
            <Link href="/dashboard/chat">Back To Conversations</Link>
          </Button>
        </div>
      </Card>

      {loading ? <p className="text-sm text-[#4b4b4b]">Loading profile...</p> : null}
      {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}

      {profile?.user ? (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-lg font-semibold text-[#121212]">{profile.user.name}</p>
              <p className="text-xs text-[#4b4b4b]">Joined {new Date(profile.user.created_at).toLocaleDateString()}</p>
            </div>
            <div className="flex gap-2">
              <Pill text={profile.user.role} />
              <Pill text={`Trust ${profile.user.reputation_score}`} />
            </div>
          </div>

          <div className="mt-3 rounded-lg border border-[#121212] bg-[#f5f5f5] p-3 text-xs text-[#4b4b4b]">
            <p>Wallet: {shortWallet(profile.user.wallet_address)}</p>
            <p className="mt-1">User ID: {profile.user.id}</p>
          </div>
        </Card>
      ) : null}
    </section>
  );
}
