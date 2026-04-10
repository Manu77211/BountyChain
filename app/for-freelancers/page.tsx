"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { listBountiesRequest } from "../../lib/api";
import { formatAlgoWithMicro } from "../../lib/algo";
import { MarketingPageShell } from "../../components/marketing/page-shell";

type MarketplaceBounty = {
  id: string;
  title: string;
  description: string;
  status: string;
  total_amount: string;
  scoring_mode: string;
  deadline: string;
  allowed_languages: string[];
};

export default function ForFreelancersPage() {
  const [query, setQuery] = useState("");
  const [bounties, setBounties] = useState<MarketplaceBounty[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadBounties = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const payload = (await listBountiesRequest({ limit: 100 })) as { data?: MarketplaceBounty[] };
      setBounties(payload.data ?? []);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBounties();
  }, [loadBounties]);

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) {
      return bounties;
    }

    return bounties.filter((bounty) => {
      const haystack = [
        bounty.title,
        bounty.description,
        bounty.allowed_languages.join(" "),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(text);
    });
  }, [bounties, query]);

  return (
    <MarketingPageShell
      title="Bounties"
      subtitle="Browse all client bounties and projects, inspect requirements, and open separate detail pages before you apply."
    >
      <section className="bg-[#f0f0f0] py-14" style={{ borderBottom: "4px solid #121212" }}>
        <div className="mx-auto max-w-7xl px-5 md:px-12">
          <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by title, description, language"
              className="w-full border-2 border-[#121212] bg-white px-3 py-2.5 text-sm text-[#121212] outline-none"
            />
            <button
              type="button"
              onClick={() => void loadBounties()}
              className="border-2 border-[#121212] bg-white px-4 py-2.5 text-sm font-bold uppercase tracking-wide text-[#121212]"
            >
              Refresh
            </button>
            <Link
              href="/marketplace"
              className="inline-flex items-center justify-center border-2 border-[#121212] bg-[#f0c020] px-4 py-2.5 text-sm font-black uppercase tracking-wide text-[#121212]"
            >
              Open Global Marketplace
            </Link>
          </div>

          {error ? <p className="mt-4 text-sm text-[#8f1515]">{error}</p> : null}
          {loading ? <p className="mt-4 text-sm text-[#3f3f3f]">Loading projects...</p> : null}

          <h2 className="mt-6 text-xl font-black uppercase tracking-tight text-[#121212]">All Bounties / Projects</h2>

          <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((bounty) => (
              <article key={bounty.id} className="border-2 border-[#121212] bg-white p-5 shadow-[6px_6px_0_#121212]">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-lg font-black uppercase tracking-tight text-[#121212]">{bounty.title}</h3>
                  <span className="border border-[#121212] bg-[#f0c020] px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-[#121212]">
                    {bounty.status}
                  </span>
                </div>
                <p className="mt-3 text-sm text-[#2a2a2a]">{bounty.description}</p>
                <p className="mt-3 text-xs text-[#4b4b4b]">
                  {formatAlgoWithMicro(bounty.total_amount)} | {bounty.scoring_mode}
                </p>
                <p className="mt-1 text-xs text-[#4b4b4b]">Deadline: {new Date(bounty.deadline).toLocaleString()}</p>
                <p className="mt-1 text-xs text-[#4b4b4b]">
                  Languages: {bounty.allowed_languages.join(", ") || "Any"}
                </p>
                <p className="mt-1 text-xs text-[#4b4b4b]">Project ID: {bounty.id}</p>

                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <Link
                    href={`/bounties/${bounty.id}`}
                    className="inline-flex items-center justify-center border-2 border-[#121212] bg-[#1040c0] px-3 py-2 text-xs font-bold uppercase tracking-wide text-white"
                  >
                    View Detail
                  </Link>
                  <Link
                    href={`/register?role=FREELANCER`}
                    className="inline-flex items-center justify-center border-2 border-[#121212] bg-white px-3 py-2 text-xs font-bold uppercase tracking-wide text-[#121212]"
                  >
                    Join as Freelancer
                  </Link>
                </div>
              </article>
            ))}
          </div>

          {!loading && filtered.length === 0 ? (
            <p className="mt-6 text-sm text-[#3f3f3f]">No projects match your search right now.</p>
          ) : null}
        </div>
      </section>
    </MarketingPageShell>
  );
}
