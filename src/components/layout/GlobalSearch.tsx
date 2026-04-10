"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { GitPullRequest, Search, Trophy } from "lucide-react";
import { listBountiesRequest, listSubmissionsRequest } from "../../../lib/api";

type BountyResult = {
  id: string;
  title: string;
  total_amount?: string;
  status?: string;
};

type SubmissionResult = {
  id: string;
  bounty_id: string;
  bounty_title: string;
  github_pr_url: string;
  final_score: number | null;
};

type SearchItem = {
  id: string;
  kind: "bounty" | "submission";
  title: string;
  subtitle: string;
  href: string;
};

export function GlobalSearch({ token }: { token: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [bounties, setBounties] = useState<BountyResult[]>([]);
  const [submissions, setSubmissions] = useState<SubmissionResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searchError, setSearchError] = useState<string | null>(null);

  const items = useMemo<SearchItem[]>(() => {
    const bountyItems = bounties.map((bounty) => ({
      id: `bounty-${bounty.id}`,
      kind: "bounty" as const,
      title: bounty.title,
      subtitle: `${bounty.total_amount ?? "0"} microALGO | ${bounty.status ?? "unknown"}`,
      href: `/bounties/${bounty.id}`,
    }));

    const submissionItems = submissions.map((submission) => ({
      id: `submission-${submission.id}`,
      kind: "submission" as const,
      title: submission.bounty_title,
      subtitle: `${submission.github_pr_url} | score ${submission.final_score ?? "pending"}`,
      href: `/submissions/${submission.id}`,
    }));

    return [...bountyItems, ...submissionItems];
  }, [bounties, submissions]);

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(0);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const isTrigger = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (isTrigger) {
        event.preventDefault();
        setOpen((value) => !value);
        return;
      }

      if (!open) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => Math.min(items.length - 1, index + 1));
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => Math.max(0, index - 1));
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        const target = items[activeIndex];
        if (!target) {
          return;
        }
        close();
        router.push(target.href);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, close, items, open, router]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handle = window.setTimeout(async () => {
      const text = query.trim().toLowerCase();
      if (!text) {
        setBounties([]);
        setSubmissions([]);
        setSearchError(null);
        return;
      }

      setLoading(true);
      setSearchError(null);
      try {
        const [bountyData, submissionData] = await Promise.all([
          listBountiesRequest({ limit: 30 }),
          token ? listSubmissionsRequest(token, { query: text, limit: 20 }) : Promise.resolve({ data: [] }),
        ]);

        const bountyItems = ((bountyData as { data?: BountyResult[] }).data ?? []).filter((item) =>
          String(item.title ?? "").toLowerCase().includes(text),
        );

        setBounties(bountyItems.slice(0, 10));
        setSubmissions(((submissionData as { data?: SubmissionResult[] }).data ?? []).slice(0, 10));
        setActiveIndex(0);
      } catch {
        setBounties([]);
        setSubmissions([]);
        setSearchError("Search service is currently unavailable.");
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => window.clearTimeout(handle);
  }, [open, query, token]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden h-10 min-w-56 items-center gap-2 rounded-none border-2 border-[#121212] bg-white px-3 text-sm text-[#5b5b5b] shadow-[3px_3px_0_#121212] hover:bg-[#f5f5f5] md:inline-flex"
      >
        <Search size={14} />
        <span className="flex-1 text-left">Search bounties, submissions...</span>
        <span className="border border-[#121212] bg-[#f0f0f0] px-1.5 py-0.5 text-[10px] uppercase">Cmd+K</span>
      </button>

      {open ? (
        <div className="fixed inset-0 z-[80] bg-black/45 backdrop-blur-sm">
          <div className="mx-auto mt-[10vh] w-[min(840px,94vw)] border-2 border-[#121212] bg-[#f0f0f0] p-4 shadow-[8px_8px_0_#121212]">
            <div className="flex items-center gap-2 border-2 border-[#121212] bg-white px-3 py-2">
              <Search size={16} className="text-text-tertiary" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search bounties, submissions..."
                className="w-full bg-transparent text-sm text-text-primary outline-none"
              />
            </div>

            <div className="mt-3 max-h-[65vh] overflow-y-auto">
              {searchError ? (
                <div className="mb-2 border border-[#be8b00] bg-[#fff4d6] p-2 text-xs text-[#7a5a00]">
                  {searchError}
                </div>
              ) : null}

              {loading ? (
                <div className="space-y-2">
                  {Array.from({ length: 6 }).map((_, index) => (
                    <div key={index} className="h-12 animate-pulse border border-[#d0d0d0] bg-[#ececec]" />
                  ))}
                </div>
              ) : items.length === 0 ? (
                <div className="border-2 border-dashed border-[#121212] p-8 text-center">
                  <p className="text-sm font-semibold text-text-primary">No results</p>
                  <p className="mt-1 text-xs text-text-tertiary">Try searching by bounty title or PR URL.</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {items.map((item, index) => (
                    <button
                      type="button"
                      key={item.id}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => {
                        close();
                        router.push(item.href);
                      }}
                      className={`flex w-full items-start gap-3 border-2 px-3 py-2 text-left ${
                        index === activeIndex
                          ? "border-[#1040c0] bg-white text-[#121212] shadow-[3px_3px_0_#121212]"
                          : "border-transparent bg-white text-text-primary hover:border-[#121212] hover:bg-[#f5f5f5]"
                      }`}
                    >
                      <span className="mt-0.5">
                        {item.kind === "bounty" ? <Trophy size={15} /> : <GitPullRequest size={15} />}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">{item.title}</span>
                        <span className="block truncate text-xs text-text-tertiary">{item.subtitle}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
