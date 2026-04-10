"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getUserFeedRequest, type UserFeedProfile } from "../../../lib/api";
import { MarketingPageShell } from "../../../components/marketing/page-shell";

function shortWallet(value: string | null) {
  if (!value) {
    return "Wallet hidden";
  }

  if (value.length <= 16) {
    return value;
  }

  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

export default function PersonProfilePage() {
  const params = useParams<{ id: string }>();
  const userId = params.id ?? "";

  const [profile, setProfile] = useState<UserFeedProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadProfile() {
      if (!userId) {
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const data = await getUserFeedRequest(userId);
        setProfile(data);
      } catch (requestError) {
        setError((requestError as Error).message);
      } finally {
        setLoading(false);
      }
    }

    void loadProfile();
  }, [userId]);

  return (
    <MarketingPageShell
      title="User Profile"
      subtitle="Full profile view with completed bounties, story timeline, and trust signals."
    >
      <section className="bg-[#f0f0f0] py-14" style={{ borderBottom: "4px solid #121212" }}>
        <div className="mx-auto max-w-5xl space-y-6 px-5 md:px-12">
          <div className="flex flex-wrap gap-2">
            <Link
              href="/people"
              className="inline-flex border-2 border-[#121212] bg-white px-4 py-2 text-xs font-black uppercase tracking-wide text-[#121212]"
            >
              Back To People Feed
            </Link>
          </div>

          {loading ? <p className="text-sm text-[#4b4b4b]">Loading profile...</p> : null}
          {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}

          {profile ? (
            <>
              <article className="rounded-2xl border-2 border-[#121212] bg-white p-6 shadow-[8px_8px_0_#121212]">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-2xl font-black uppercase text-[#121212]">{profile.user.name}</p>
                    <p className="mt-1 text-sm text-[#4b4b4b]">Role: {profile.user.role}</p>
                    <p className="text-sm text-[#4b4b4b]">Wallet: {shortWallet(profile.user.wallet_address)}</p>
                    <p className="text-sm text-[#4b4b4b]">Joined: {new Date(profile.user.created_at).toLocaleDateString()}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <span className="border border-[#121212] bg-[#eef5ff] px-3 py-1 text-xs font-bold uppercase">Trust {profile.user.reputation_score}</span>
                    <span className="border border-[#121212] bg-[#fff8e6] px-3 py-1 text-xs font-bold uppercase">Posted {profile.stats.postedBounties}</span>
                    <span className="border border-[#121212] bg-[#e9ffe9] px-3 py-1 text-xs font-bold uppercase">Completed {profile.stats.completedBounties}</span>
                    <span className="border border-[#121212] bg-[#ffe7e7] px-3 py-1 text-xs font-bold uppercase">Passed {profile.stats.passedSubmissions}</span>
                  </div>
                </div>
              </article>

              <div className="grid gap-6 lg:grid-cols-2">
                <article className="rounded-2xl border-2 border-[#121212] bg-white p-5 shadow-[6px_6px_0_#121212]">
                  <p className="text-xs font-black uppercase tracking-widest text-[#4b4b4b]">Recent Completed Bounties</p>
                  <div className="mt-3 space-y-2">
                    {profile.recentCompletedBounties.map((item) => (
                      <Link
                        key={`${item.id}-${item.completedAt}`}
                        href={`/bounties/${item.id}`}
                        className="block rounded-lg border border-[#121212] bg-[#f8f8f8] p-3"
                      >
                        <p className="text-sm font-bold text-[#121212]">{item.title}</p>
                        <p className="mt-1 text-xs text-[#4b4b4b]">
                          {item.asRole} | {new Date(item.completedAt).toLocaleString()}
                        </p>
                      </Link>
                    ))}
                    {profile.recentCompletedBounties.length === 0 ? (
                      <p className="text-sm text-[#4b4b4b]">No completed bounties yet.</p>
                    ) : null}
                  </div>
                </article>

                <article className="rounded-2xl border-2 border-[#121212] bg-white p-5 shadow-[6px_6px_0_#121212]">
                  <p className="text-xs font-black uppercase tracking-widest text-[#4b4b4b]">Recent Stories</p>
                  <div className="mt-3 space-y-2">
                    {profile.recentStories.map((story, index) => (
                      <div key={`${story.at}-${index}`} className="rounded-lg border border-[#121212] bg-[#fff8e6] p-3">
                        <p className="text-sm font-semibold text-[#121212]">{story.label}</p>
                        <p className="mt-1 text-xs text-[#4b4b4b]">{new Date(story.at).toLocaleString()}</p>
                      </div>
                    ))}
                    {profile.recentStories.length === 0 ? (
                      <p className="text-sm text-[#4b4b4b]">No recent stories available.</p>
                    ) : null}
                  </div>
                </article>
              </div>
            </>
          ) : null}
        </div>
      </section>
    </MarketingPageShell>
  );
}
