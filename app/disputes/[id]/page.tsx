"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  challengeDisputeArbitratorRequest,
  getDisputeActivityRequest,
  getDisputeRequest,
  voteDisputeRequest,
} from "../../../lib/api";
import { useRealtimeChannel } from "../../../lib/realtime-client";
import { AppShell } from "../../../src/components/layout/AppShell";
import { Protected } from "../../../components/protected";
import { Button, Card, PageIntro, Pill, ProgressBar, Select, Textarea } from "../../../components/ui/primitives";
import { useAuthStore } from "../../../store/auth-store";

type DisputeDetailResponse = {
  dispute: {
    id: string;
    submission_id: string;
    raised_by: string;
    reason: string;
    dispute_type: string;
    status: string;
    outcome: string | null;
    raised_at: string;
    resolved_at: string | null;
    settlement_tx_id: string | null;
    settlement_payload: Record<string, unknown> | null;
  };
  submission: {
    id: string;
    status: string;
    cached_pr_diff: string | null;
    ai_score_raw: Record<string, unknown> | null;
    final_score: number | null;
    ci_status: string;
    ci_run_id: string | null;
    skipped_test_count: number;
    total_test_count: number;
    evidence_source: "live" | "cache";
    github_pr_url: string;
    github_branch: string;
    head_sha: string | null;
  };
  bounty: {
    id: string;
    title: string;
    requirements: string;
    repo_url: string;
    target_branch: string;
  };
  votes: Array<{
    arbitrator_id: string;
    is_challenged?: boolean;
    vote?: string | null;
    justification?: string | null;
    has_voted?: boolean;
  }>;
  meta?: {
    vote_progress: {
      total_votes: number;
      votes_in: number;
    };
    viewer_assignment_status: "unassigned" | "active" | "challenged" | "inactive";
    viewer_has_voted: boolean;
    challenge_usage: {
      client_used: boolean;
      freelancer_used: boolean;
    };
  };
};

type DisputeActivityResponse = {
  data: Array<{
    id: string;
    label: string;
    at: string;
    detail?: string;
  }>;
  vote_progress: {
    votes_in: number;
    total_votes: number;
  };
};

type EvidenceTab = "requirements" | "submission" | "ai" | "ci" | "timeline";

function asPrettyJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

function diffChangedFilesCount(diff: string | null) {
  if (!diff) {
    return 0;
  }
  const matches = diff.match(/^diff --git /gm);
  return matches?.length ?? 0;
}

function anonymizedArbitratorLabel(index: number) {
  const code = "A".charCodeAt(0) + index;
  return `Arbitrator ${String.fromCharCode(code)}`;
}

export default function DisputeDetailPage() {
  const params = useParams<{ id: string }>();
  const disputeId = params.id;
  const { token, user, hydrate } = useAuthStore();

  const [detail, setDetail] = useState<DisputeDetailResponse | null>(null);
  const [activity, setActivity] = useState<DisputeActivityResponse["data"]>([]);
  const [activeTab, setActiveTab] = useState<EvidenceTab>("requirements");
  const [vote, setVote] = useState<"freelancer_wins" | "client_wins" | "split">("split");
  const [splitShare, setSplitShare] = useState(50);
  const [justification, setJustification] = useState("");
  const [challengeArbitratorId, setChallengeArbitratorId] = useState("");
  const [challengeReason, setChallengeReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState(false);
  const [challenging, setChallenging] = useState(false);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const load = useCallback(async () => {
    if (!token || !disputeId) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [detailResponse, activityResponse] = await Promise.all([
        getDisputeRequest(token, disputeId) as Promise<DisputeDetailResponse>,
        getDisputeActivityRequest(token, disputeId) as Promise<DisputeActivityResponse>,
      ]);
      setDetail(detailResponse);
      setActivity(activityResponse.data ?? []);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [disputeId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const arbitrationOptions = useMemo(() => {
    return (detail?.votes ?? [])
      .filter((entry) => !entry.is_challenged)
      .map((entry) => entry.arbitrator_id);
  }, [detail?.votes]);

  const progress = useMemo(() => {
    const voteProgress = detail?.meta?.vote_progress;
    if (voteProgress) {
      return voteProgress;
    }
    const totalVotes = detail?.votes.length ?? 0;
    const votesIn = (detail?.votes ?? []).filter((entry) => Boolean(entry.has_voted ?? entry.vote)).length;
    return { total_votes: totalVotes, votes_in: votesIn };
  }, [detail]);

  const votePercent = progress.total_votes > 0 ? Math.round((progress.votes_in / progress.total_votes) * 100) : 0;

  useRealtimeChannel({
    token,
    disputeId,
    bountyId: detail?.bounty.id,
    onEvent: (eventName) => {
      if (eventName === "dispute:vote_cast" || eventName === "dispute:resolved" || eventName === "bounty:disputed") {
        void load();
      }
    },
  });

  async function onVote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !disputeId) {
      return;
    }

    setVoting(true);
    setError(null);

    try {
      const trimmed = justification.trim();
      const voteJustification =
        vote === "split" ? `${trimmed}\n\nFreelancer share recommendation: ${splitShare}%` : trimmed;

      await voteDisputeRequest(token, disputeId, {
        vote,
        justification: voteJustification,
      });
      setJustification("");
      await load();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setVoting(false);
    }
  }

  async function onChallenge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !disputeId) {
      return;
    }

    const confirmed = window.confirm("Challenge this arbitrator? Each party can challenge only one arbitrator.");
    if (!confirmed) {
      return;
    }

    setChallenging(true);
    setError(null);

    try {
      await challengeDisputeArbitratorRequest(token, disputeId, {
        arbitrator_id: challengeArbitratorId,
        justification: challengeReason.trim(),
      });
      setChallengeArbitratorId("");
      setChallengeReason("");
      await load();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setChallenging(false);
    }
  }

  const role = String(user?.role ?? "").toLowerCase();
  const canVote =
    role === "arbitrator" &&
    detail?.dispute.status === "under_review" &&
    detail?.meta?.viewer_assignment_status === "active" &&
    !detail?.meta?.viewer_has_voted;

  const challengeUsed =
    role === "client"
      ? detail?.meta?.challenge_usage.client_used
      : role === "freelancer"
        ? detail?.meta?.challenge_usage.freelancer_used
        : true;

  const canChallenge =
    (role === "client" || role === "freelancer") &&
    detail?.dispute.status === "under_review" &&
    !challengeUsed;

  const isViewerChallenged = detail?.meta?.viewer_assignment_status === "challenged";

  return (
    <Protected>
      <AppShell>
        <section className="space-y-6">
          <PageIntro title="Dispute Workspace" subtitle="Review evidence, arbitration timeline, and outcome controls from one place." />

          {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}
          {loading ? <p className="text-sm text-[#4b4b4b]">Loading dispute...</p> : null}

          {detail ? (
            <>
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold">Dispute #{detail.dispute.id.slice(0, 8)}</h2>
                    <p className="text-sm text-[#4b4b4b]">{detail.bounty.title}</p>
                    <p className="text-xs text-[#4b4b4b]">Raised by {detail.dispute.raised_by.slice(0, 8)} on {new Date(detail.dispute.raised_at).toLocaleString()}</p>
                  </div>
                  <div className="flex gap-2">
                    <Pill text={detail.dispute.status} />
                    <Pill text={detail.dispute.dispute_type} />
                    {detail.dispute.outcome ? <Pill text={detail.dispute.outcome} /> : null}
                  </div>
                </div>
                <p className="mt-3 rounded-xl border border-[#121212] bg-[#f5f5f5] p-3 text-sm text-[#2a2a2a]">
                  {detail.dispute.reason}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button asChild variant="secondary">
                    <Link href={`/submissions/${detail.submission.id}`}>Open Submission</Link>
                  </Button>
                  <Button asChild variant="secondary">
                    <Link href={`/dashboard/chat/${detail.bounty.id}`}>Open Bounty Chat</Link>
                  </Button>
                  <Button asChild>
                    <Link href={detail.submission.github_pr_url} target="_blank">Open PR</Link>
                  </Button>
                </div>
              </Card>

              <div className="grid gap-4 lg:grid-cols-[2fr,1fr]">
                <div className="space-y-4">
                  <Card>
                    <div className="flex flex-wrap gap-2 border-b border-[#d5d5d5] pb-3">
                      <Button
                        variant={activeTab === "requirements" ? "primary" : "secondary"}
                        onClick={() => setActiveTab("requirements")}
                      >
                        Bounty Requirements
                      </Button>
                      <Button
                        variant={activeTab === "submission" ? "primary" : "secondary"}
                        onClick={() => setActiveTab("submission")}
                      >
                        Code Submission
                      </Button>
                      <Button variant={activeTab === "ai" ? "primary" : "secondary"} onClick={() => setActiveTab("ai")}>
                        AI Score Report
                      </Button>
                      <Button variant={activeTab === "ci" ? "primary" : "secondary"} onClick={() => setActiveTab("ci")}>
                        CI/CD Results
                      </Button>
                      <Button
                        variant={activeTab === "timeline" ? "primary" : "secondary"}
                        onClick={() => setActiveTab("timeline")}
                      >
                        Activity Log
                      </Button>
                    </div>

                    {activeTab === "requirements" ? (
                      <div className="mt-4 space-y-2 text-sm">
                        <p className="font-semibold">Acceptance Criteria</p>
                        <pre className="overflow-x-auto rounded-xl border border-[#121212] bg-[#111827] p-4 font-mono text-xs text-[#dbeafe]">
                          {detail.bounty.requirements || "No requirements provided."}
                        </pre>
                      </div>
                    ) : null}

                    {activeTab === "submission" ? (
                      <div className="mt-4 space-y-3 text-sm">
                        <p>
                          PR: <a className="underline" target="_blank" rel="noreferrer" href={detail.submission.github_pr_url}>{detail.submission.github_pr_url}</a>
                        </p>
                        <p>Branch: {detail.submission.github_branch || detail.bounty.target_branch}</p>
                        <p>Head SHA: {detail.submission.head_sha ?? "Not available"}</p>
                        <p>Files changed: {diffChangedFilesCount(detail.submission.cached_pr_diff)}</p>
                        <div className="flex flex-wrap gap-2">
                          <Pill text={`evidence ${detail.submission.evidence_source}`} />
                          {detail.submission.evidence_source === "cache" ? <Pill text="EXCEPTION GH-F-006" /> : null}
                        </div>
                        {detail.submission.evidence_source === "cache" ? (
                          <p className="rounded-xl border border-[#be8b00] bg-[#fff4d6] p-2 text-xs text-[#7a5a00]">
                            Evidence loaded from cache — original repo may have been deleted.
                          </p>
                        ) : null}
                        <pre className="max-h-[360px] overflow-auto rounded-xl border border-[#121212] bg-[#111827] p-3 font-mono text-xs text-[#dbeafe]">
                          {detail.submission.cached_pr_diff ?? "No cached PR diff available for this submission."}
                        </pre>
                      </div>
                    ) : null}

                    {activeTab === "ai" ? (
                      <div className="mt-4 space-y-3">
                        <div className="grid gap-3 sm:grid-cols-3">
                          <div className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3 text-sm">
                            <p className="text-xs text-[#4b4b4b]">Final Score</p>
                            <p className="text-xl font-bold">{detail.submission.final_score ?? "Pending"}</p>
                          </div>
                          <div className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3 text-sm">
                            <p className="text-xs text-[#4b4b4b]">Evidence Source</p>
                            <p className="text-xl font-bold uppercase">{detail.submission.evidence_source}</p>
                          </div>
                          <div className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3 text-sm">
                            <p className="text-xs text-[#4b4b4b]">Submission Status</p>
                            <p className="text-xl font-bold uppercase">{detail.submission.status}</p>
                          </div>
                        </div>
                        <pre className="overflow-x-auto rounded-xl border border-[#121212] bg-[#111827] p-4 text-xs text-[#dbeafe]">
                          {asPrettyJson(detail.submission.ai_score_raw)}
                        </pre>
                      </div>
                    ) : null}

                    {activeTab === "ci" ? (
                      <div className="mt-4 space-y-3 text-sm">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                            <p className="text-xs text-[#4b4b4b]">CI Status</p>
                            <p className="text-lg font-bold uppercase">{detail.submission.ci_status}</p>
                          </div>
                          <div className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                            <p className="text-xs text-[#4b4b4b]">CI Run ID</p>
                            <p className="text-lg font-bold">{detail.submission.ci_run_id ?? "Pending"}</p>
                          </div>
                        </div>
                        <p>
                          Tests: {detail.submission.total_test_count - detail.submission.skipped_test_count}/
                          {detail.submission.total_test_count} executed
                        </p>
                        {detail.submission.skipped_test_count > 0 ? (
                          <p className="rounded-xl border border-[#be8b00] bg-[#fff4d6] p-2 text-xs text-[#7a5a00]">
                            Warning GH-F-004: {detail.submission.skipped_test_count} tests were skipped.
                          </p>
                        ) : null}
                        {detail.submission.ci_run_id ? (
                          <p>
                            <a
                              href={`https://github.com/search?q=${encodeURIComponent(detail.submission.ci_run_id)}`}
                              target="_blank"
                              rel="noreferrer"
                              className="underline"
                            >
                              Open GitHub Actions
                            </a>
                          </p>
                        ) : null}
                        <ProgressBar
                          value={
                            detail.submission.total_test_count > 0
                              ? ((detail.submission.total_test_count - detail.submission.skipped_test_count) /
                                  detail.submission.total_test_count) *
                                100
                              : 0
                          }
                        />
                      </div>
                    ) : null}

                    {activeTab === "timeline" ? (
                      <div className="mt-4 space-y-3">
                        {activity.map((item) => (
                          <div key={item.id} className="relative border-l-2 border-[#d0d0d0] pl-4">
                            <span className="absolute -left-[6px] top-[5px] h-2.5 w-2.5 rounded-full bg-[#1040c0]" />
                            <p className="text-sm font-semibold">{item.label}</p>
                            <p className="text-xs text-[#4b4b4b]">{new Date(item.at).toLocaleString()}</p>
                            {item.detail ? <p className="text-xs text-[#4b4b4b]">{item.detail}</p> : null}
                          </div>
                        ))}
                        {activity.length === 0 ? <p className="text-sm text-[#4b4b4b]">No activity entries yet.</p> : null}
                      </div>
                    ) : null}
                  </Card>
                </div>

                <div className="space-y-4">
                  <Card className="space-y-3">
                    <h3 className="text-lg font-semibold">Resolution Progress</h3>
                    <p className="text-sm text-[#4b4b4b]">
                      {progress.votes_in}/{progress.total_votes} active arbitrator votes submitted
                    </p>
                    <ProgressBar value={votePercent} />
                    {detail.dispute.outcome ? <Pill text={`Outcome: ${detail.dispute.outcome}`} /> : <Pill text="Outcome pending" />}
                  </Card>

                  <Card>
                    <h3 className="text-lg font-semibold">Current Votes</h3>
                    <div className="mt-3 space-y-2">
                      {detail.votes.map((entry, index) => (
                        <div key={entry.arbitrator_id} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                          <p className="text-xs font-medium">
                            {role === "client" || role === "freelancer"
                              ? anonymizedArbitratorLabel(index)
                              : `Arbitrator ${entry.arbitrator_id.slice(0, 8)}`}
                          </p>
                          <p className="text-xs text-[#4b4b4b]">
                            {entry.vote ?? (entry.has_voted ? "Vote submitted" : "Vote pending")}
                          </p>
                          {entry.justification ? (
                            <p className="mt-1 text-xs text-[#4b4b4b] line-clamp-3">{entry.justification}</p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </Card>

                  {canVote ? (
                    <Card>
                      <h3 className="text-lg font-semibold">Cast your vote</h3>
                      <form className="mt-3 space-y-3" onSubmit={onVote}>
                        <Select value={vote} onChange={(event) => setVote(event.target.value as "freelancer_wins" | "client_wins" | "split")}>
                          <option value="freelancer_wins">Freelancer wins — release full amount</option>
                          <option value="client_wins">Client wins — full refund</option>
                          <option value="split">Split payment</option>
                        </Select>
                        {vote === "split" ? (
                          <div className="space-y-1">
                            <label className="text-xs font-semibold">Freelancer {splitShare}% — Client {100 - splitShare}%</label>
                            <input
                              type="range"
                              min={0}
                              max={100}
                              value={splitShare}
                              onChange={(event) => setSplitShare(Number(event.target.value))}
                              className="w-full"
                            />
                          </div>
                        ) : null}
                        <Textarea
                          rows={5}
                          value={justification}
                          onChange={(event) => setJustification(event.target.value)}
                          placeholder="Minimum 50 characters"
                          required
                        />
                        <p className="text-xs text-[#4b4b4b]">{justification.trim().length} / 50 minimum</p>
                        <Button type="submit" disabled={voting || justification.trim().length < 50}>
                          {voting ? "Submitting..." : "Submit Vote"}
                        </Button>
                      </form>
                    </Card>
                  ) : (
                    <Card>
                      <p className="text-sm text-[#4b4b4b]">
                        {isViewerChallenged
                          ? "You have been challenged and replaced. You cannot vote on this dispute."
                          : role === "arbitrator"
                            ? "Vote submitted. Waiting for other arbitrators."
                          : "Voting is available only to actively assigned arbitrators."}
                      </p>
                    </Card>
                  )}

                  {canChallenge ? (
                    <Card>
                      <h3 className="text-lg font-semibold">Challenge Arbitrator</h3>
                      <p className="mt-1 text-xs text-[#4b4b4b]">Each party can challenge 1 arbitrator.</p>
                      <form className="mt-3 space-y-3" onSubmit={onChallenge}>
                        <Select value={challengeArbitratorId} onChange={(event) => setChallengeArbitratorId(event.target.value)}>
                          <option value="">Select arbitrator</option>
                          {arbitrationOptions.map((id, index) => (
                            <option key={id} value={id}>{anonymizedArbitratorLabel(index)}</option>
                          ))}
                        </Select>
                        <Textarea
                          value={challengeReason}
                          onChange={(event) => setChallengeReason(event.target.value)}
                          placeholder="Minimum 50 characters"
                          minLength={50}
                          rows={4}
                          required
                        />
                        <Button
                          type="submit"
                          disabled={challenging || !challengeArbitratorId || challengeReason.trim().length < 50}
                        >
                          {challenging ? "Submitting..." : "Submit Challenge"}
                        </Button>
                      </form>
                    </Card>
                  ) : (
                    <Card>
                      <p className="text-sm text-[#4b4b4b]">
                        {role === "client" || role === "freelancer"
                          ? "Challenge used — you cannot challenge another arbitrator."
                          : "Challenge is available only to dispute parties."}
                      </p>
                    </Card>
                  )}

                  {detail.dispute.outcome ? (
                    <Card>
                      <h3 className="text-lg font-semibold">Outcome</h3>
                      <p className="mt-2 text-xl font-black uppercase">{String(detail.dispute.outcome).replaceAll("_", " ")}</p>
                      <p className="mt-2 text-xs text-[#4b4b4b]">Transaction: {detail.dispute.settlement_tx_id ?? "Pending"}</p>
                      {detail.dispute.settlement_tx_id ? (
                        <a
                          href={`https://testnet.algoexplorer.io/tx/${detail.dispute.settlement_tx_id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-block text-xs underline"
                        >
                          View on Algorand explorer
                        </a>
                      ) : null}
                      <pre className="mt-2 max-h-[220px] overflow-auto rounded-xl border border-[#121212] bg-[#f5f5f5] p-2 text-xs">
                        {asPrettyJson(detail.dispute.settlement_payload)}
                      </pre>
                    </Card>
                  ) : null}
                </div>
              </div>
            </>
          ) : null}
        </section>
      </AppShell>
    </Protected>
  );
}
