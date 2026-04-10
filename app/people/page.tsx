"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { discoverPeopleRequest, type DiscoverPerson } from "../../lib/api";
import { MarketingPageShell } from "../../components/marketing/page-shell";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "U";
}

function shortWallet(value: string | null) {
  if (!value) {
    return "Wallet hidden";
  }

  if (value.length <= 14) {
    return value;
  }

  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

export default function PeopleFeedPage() {
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "client" | "freelancer">("all");
  const [people, setPeople] = useState<DiscoverPerson[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPeople = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await discoverPeopleRequest({
        q: search.trim() || undefined,
        role: roleFilter,
        limit: 60,
      });
      setPeople(data);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [roleFilter, search]);

  useEffect(() => {
    void loadPeople();
  }, [loadPeople]);

  const clients = useMemo(
    () => people.filter((item) => item.role === "CLIENT"),
    [people],
  );

  const freelancers = useMemo(
    () => people.filter((item) => item.role === "FREELANCER"),
    [people],
  );

  const stories = useMemo(() => {
    return people
      .flatMap((person) =>
        (person.recentStories ?? []).slice(0, 1).map((story) => ({
          userId: person.id,
          name: person.name,
          label: story.label,
          at: story.at,
        })),
      )
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 12);
  }, [people]);

  return (
    <MarketingPageShell
      title="People Feed"
      subtitle="Instagram-style community feed to browse clients and freelancers with stories, completed bounty highlights, and direct profile access."
    >
      <section className="bg-[#f0f0f0] py-14" style={{ borderBottom: "4px solid #121212" }}>
        <div className="mx-auto max-w-7xl space-y-6 px-5 md:px-12">
          <div className="rounded-2xl border-2 border-[#121212] bg-white p-4 shadow-[6px_6px_0_#121212]">
            <div className="grid gap-3 md:grid-cols-[1fr_auto_auto_auto]">
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search clients or freelancers"
                className="w-full border-2 border-[#121212] px-3 py-2 text-sm outline-none"
              />
              <button
                type="button"
                onClick={() => setRoleFilter("all")}
                className={`border-2 border-[#121212] px-3 py-2 text-xs font-black uppercase ${
                  roleFilter === "all" ? "bg-[#1040c0] text-white" : "bg-white text-[#121212]"
                }`}
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setRoleFilter("client")}
                className={`border-2 border-[#121212] px-3 py-2 text-xs font-black uppercase ${
                  roleFilter === "client" ? "bg-[#1040c0] text-white" : "bg-white text-[#121212]"
                }`}
              >
                Clients
              </button>
              <button
                type="button"
                onClick={() => setRoleFilter("freelancer")}
                className={`border-2 border-[#121212] px-3 py-2 text-xs font-black uppercase ${
                  roleFilter === "freelancer" ? "bg-[#1040c0] text-white" : "bg-white text-[#121212]"
                }`}
              >
                Freelancers
              </button>
            </div>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => void loadPeople()}
                className="border-2 border-[#121212] bg-[#f0c020] px-4 py-2 text-xs font-black uppercase"
              >
                Refresh Feed
              </button>
            </div>
          </div>

          <div className="rounded-2xl border-2 border-[#121212] bg-white p-4 shadow-[6px_6px_0_#121212]">
            <p className="text-xs font-black uppercase tracking-widest text-[#4b4b4b]">Recent Stories</p>
            <div className="mt-3 flex gap-3 overflow-x-auto pb-1">
              {stories.map((story) => (
                <Link
                  key={`${story.userId}-${story.at}`}
                  href={`/people/${story.userId}`}
                  className="min-w-[130px] rounded-xl border-2 border-[#121212] bg-[#fff8e6] p-2"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[#121212] bg-[#f0c020] text-xs font-black text-[#121212]">
                    {initials(story.name)}
                  </div>
                  <p className="mt-2 line-clamp-2 text-[11px] font-bold text-[#121212]">{story.label}</p>
                  <p className="mt-1 text-[10px] text-[#4b4b4b]">{new Date(story.at).toLocaleDateString()}</p>
                </Link>
              ))}
              {stories.length === 0 ? <p className="text-sm text-[#4b4b4b]">No stories yet.</p> : null}
            </div>
          </div>

          {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}
          {loading ? <p className="text-sm text-[#4b4b4b]">Loading people feed...</p> : null}

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-3">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-[#1040c0]">Clients</p>
              {clients.map((person) => (
                <article key={person.id} className="rounded-2xl border-2 border-[#121212] bg-white p-4 shadow-[6px_6px_0_#121212]">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-[#121212] bg-[#f0c020] text-sm font-black">
                        {initials(person.name)}
                      </div>
                      <div>
                        <p className="font-black text-[#121212]">{person.name}</p>
                        <p className="text-xs text-[#4b4b4b]">{shortWallet(person.walletAddress)}</p>
                      </div>
                    </div>
                    <span className="border border-[#121212] bg-[#eef5ff] px-2 py-1 text-[10px] font-bold uppercase">Trust {person.reputationScore}</span>
                  </div>

                  <p className="mt-3 text-xs font-semibold text-[#4b4b4b]">Recent completed bounties</p>
                  <div className="mt-1 space-y-1">
                    {(person.recentCompletedBounties ?? []).slice(0, 3).map((item) => (
                      <p key={`${person.id}-${item.id}-${item.completedAt}`} className="text-xs text-[#121212]">
                        {item.title}
                      </p>
                    ))}
                    {(person.recentCompletedBounties ?? []).length === 0 ? (
                      <p className="text-xs text-[#4b4b4b]">No completed bounties yet.</p>
                    ) : null}
                  </div>

                  <Link
                    href={`/people/${person.id}`}
                    className="mt-4 inline-flex border-2 border-[#121212] bg-[#1040c0] px-3 py-2 text-xs font-black uppercase text-white"
                  >
                    View Full Profile
                  </Link>
                </article>
              ))}
              {!loading && clients.length === 0 ? (
                <p className="text-sm text-[#4b4b4b]">No clients found.</p>
              ) : null}
            </div>

            <div className="space-y-3">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-[#d02020]">Freelancers</p>
              {freelancers.map((person) => (
                <article key={person.id} className="rounded-2xl border-2 border-[#121212] bg-white p-4 shadow-[6px_6px_0_#121212]">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-[#121212] bg-[#f0c020] text-sm font-black">
                        {initials(person.name)}
                      </div>
                      <div>
                        <p className="font-black text-[#121212]">{person.name}</p>
                        <p className="text-xs text-[#4b4b4b]">{shortWallet(person.walletAddress)}</p>
                      </div>
                    </div>
                    <span className="border border-[#121212] bg-[#ffe7e7] px-2 py-1 text-[10px] font-bold uppercase">Trust {person.reputationScore}</span>
                  </div>

                  <p className="mt-3 text-xs font-semibold text-[#4b4b4b]">Recent completed bounties</p>
                  <div className="mt-1 space-y-1">
                    {(person.recentCompletedBounties ?? []).slice(0, 3).map((item) => (
                      <p key={`${person.id}-${item.id}-${item.completedAt}`} className="text-xs text-[#121212]">
                        {item.title}
                      </p>
                    ))}
                    {(person.recentCompletedBounties ?? []).length === 0 ? (
                      <p className="text-xs text-[#4b4b4b]">No completed work yet.</p>
                    ) : null}
                  </div>

                  <Link
                    href={`/people/${person.id}`}
                    className="mt-4 inline-flex border-2 border-[#121212] bg-[#1040c0] px-3 py-2 text-xs font-black uppercase text-white"
                  >
                    View Full Profile
                  </Link>
                </article>
              ))}
              {!loading && freelancers.length === 0 ? (
                <p className="text-sm text-[#4b4b4b]">No freelancers found.</p>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </MarketingPageShell>
  );
}
