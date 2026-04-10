"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { listSubmissionsRequest, openDisputeRequest, retriggerSubmissionCiRequest } from "../../lib/api";
import { AppShell } from "../../src/components/layout/AppShell";
import { Protected } from "../../components/protected";
import { Button, Card, Input, PageIntro, Pill, ProgressBar } from "../../components/ui/primitives";
import { useAuthStore } from "../../store/auth-store";

type SubmissionListItem = {
  id: string;
  bounty_id: string;
  bounty_title: string;
  github_pr_url: string;
  final_score: number | null;
  status: string;
  ci_status: string;
  submission_received_at: string;
  deadline: string;
  payout_status: string | null;
  payout_amount: string | null;
  payout_tx_id: string | null;
  dispute_id: string | null;
  dispute_status: string | null;
  created_at: string;
};

function within48h(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  return diff <= 48 * 60 * 60 * 1000;
}

function asAlgo(value: string | null | undefined) {
  return Number(value ?? "0") / 1_000_000;
}

export default function SubmissionsPage() {
  const { token, hydrate } = useAuthStore();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SubmissionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const load = useCallback(async () => {
    if (!token) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = (await listSubmissionsRequest(token, {
        query: query.trim() || undefined,
        limit: 50,
      })) as { data?: SubmissionListItem[] };
      setItems(response.data ?? []);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onRetriggerCi(submissionId: string) {
    if (!token) {
      return;
    }
    setActionLoadingId(submissionId);
    setError(null);
    try {
      await retriggerSubmissionCiRequest(token, submissionId);
      await load();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setActionLoadingId(null);
    }
  }

  async function onOpenDispute(item: SubmissionListItem) {
    if (!token) {
      return;
    }
    setActionLoadingId(item.id);
    setError(null);
    try {
      await openDisputeRequest(token, {
        submission_id: item.id,
        dispute_type: "score_unfair",
        reason:
          "I request a dispute because the submission score/payout outcome appears unfair and needs arbitration review against bounty criteria.",
      });
      await load();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setActionLoadingId(null);
    }
  }

  return (
    <Protected>
      <AppShell>
        <section className="space-y-6">
          <PageIntro title="My Submissions" subtitle="Track CI, score, payout, and dispute eligibility for each bounty submission." />

          <Card>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search bounty title or PR URL" />
              <Button variant="secondary" onClick={() => void load()}>Refresh</Button>
            </div>
          </Card>

          {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}
          {loading ? <p className="text-sm text-[#4b4b4b]">Loading submissions...</p> : null}

          <Card>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[#d8d8d8] text-xs uppercase tracking-wide text-[#4b4b4b]">
                    <th className="py-2 pr-4">Bounty</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">CI</th>
                    <th className="py-2 pr-4">Score</th>
                    <th className="py-2 pr-4">Deadline</th>
                    <th className="py-2 pr-4">Payout</th>
                    <th className="py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const canOpenDispute =
                      !item.dispute_id && item.final_score !== null && within48h(item.submission_received_at || item.created_at);
                    const canRetriggerCi = item.ci_status === "failed";

                    return (
                      <tr key={item.id} className="border-b border-[#ececec] align-top">
                        <td className="py-3 pr-4">
                          <p className="font-semibold text-[#121212]">{item.bounty_title}</p>
                          <p className="text-xs text-[#4b4b4b]">{item.id.slice(0, 8)}</p>
                          <a className="text-xs underline text-[#1040c0]" href={item.github_pr_url} target="_blank" rel="noreferrer">
                            PR Link
                          </a>
                        </td>
                        <td className="py-3 pr-4"><Pill text={item.status} /></td>
                        <td className="py-3 pr-4">
                          <Pill text={item.ci_status} />
                        </td>
                        <td className="py-3 pr-4 min-w-[180px]">
                          <p className="mb-1 text-xs text-[#4b4b4b]">{item.final_score ?? "Pending"}{item.final_score !== null ? "/100" : ""}</p>
                          <ProgressBar value={item.final_score ?? 0} />
                        </td>
                        <td className="py-3 pr-4 text-xs text-[#4b4b4b]">{new Date(item.deadline).toLocaleString()}</td>
                        <td className="py-3 pr-4">
                          <p>{item.payout_status ?? "pending"}</p>
                          <p className="text-xs text-[#4b4b4b]">{asAlgo(item.payout_amount).toFixed(6)} ALGO</p>
                          {item.payout_tx_id ? <p className="text-xs text-[#4b4b4b]">Tx: {item.payout_tx_id.slice(0, 14)}</p> : null}
                        </td>
                        <td className="py-3">
                          <div className="flex flex-wrap gap-2">
                            <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                              <Link href={`/bounties/${item.bounty_id}`}>View Bounty</Link>
                            </Button>
                            <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                              <Link href={`/submissions/${item.id}`}>View Submission</Link>
                            </Button>
                            {item.dispute_id ? (
                              <Button asChild className="h-8 px-3 text-xs">
                                <Link href={`/disputes/${item.dispute_id}`}>View Dispute</Link>
                              </Button>
                            ) : (
                              <Button
                                className="h-8 px-3 text-xs"
                                onClick={() => void onOpenDispute(item)}
                                disabled={!canOpenDispute || actionLoadingId === item.id}
                              >
                                {canOpenDispute ? "Open Dispute" : "Dispute Closed"}
                              </Button>
                            )}
                            {canRetriggerCi ? (
                              <Button
                                variant="secondary"
                                className="h-8 px-3 text-xs"
                                onClick={() => void onRetriggerCi(item.id)}
                                disabled={actionLoadingId === item.id}
                              >
                                Retry CI
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {!loading && items.length === 0 ? (
            <Card>
              <p className="text-sm text-[#4b4b4b]">No submissions yet — browse bounties to get started.</p>
              <Button asChild className="mt-3">
                <Link href="/bounties">Browse Bounties</Link>
              </Button>
            </Card>
          ) : null}
        </section>
      </AppShell>
    </Protected>
  );
}
