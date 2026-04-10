"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  challengeDisputeArbitratorRequest,
  getDisputeRequest,
  voteDisputeRequest,
} from "../../../lib/api";
import { useRealtimeChannel } from "../../../lib/realtime-client";
import { DashboardShell } from "../../../components/dashboard-shell";
import { Protected } from "../../../components/protected";
import { Button, Card, Input, PageIntro, Pill, Select, Textarea } from "../../../components/ui/primitives";
import { useAuthStore } from "../../../store/auth-store";

type DisputeDetail = {
  dispute: {
    id: string;
    submission_id: string;
    reason: string;
    dispute_type: string;
    status: string;
    outcome: string | null;
    raised_at: string;
    resolved_at: string | null;
  };
  submission: {
    id: string;
    status: string;
    final_score: number | null;
    ci_status: string;
    github_pr_url: string;
  };
  bounty: {
    id: string;
    requirements: string;
    repo_url: string;
    target_branch: string;
  };
  votes: Array<{
    arbitrator_id: string;
    vote?: string | null;
    justification?: string | null;
    has_voted?: boolean;
  }>;
};

export default function DisputeDetailPage() {
  const params = useParams<{ id: string }>();
  const disputeId = params.id;
  const { token, user, hydrate } = useAuthStore();

  const [detail, setDetail] = useState<DisputeDetail | null>(null);
  const [vote, setVote] = useState<"freelancer_wins" | "client_wins" | "split">("split");
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
      const response = (await getDisputeRequest(token, disputeId)) as DisputeDetail;
      setDetail(response);
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
    return (detail?.votes ?? []).map((entry) => entry.arbitrator_id);
  }, [detail?.votes]);

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
      await voteDisputeRequest(token, disputeId, {
        vote,
        justification: justification.trim(),
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

    setChallenging(true);
    setError(null);

    try {
      await challengeDisputeArbitratorRequest(token, disputeId, {
        arbitrator_id: challengeArbitratorId,
        justification: challengeReason.trim(),
      });
      setChallengeReason("");
      await load();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setChallenging(false);
    }
  }

  const role = String(user?.role ?? "").toLowerCase();
  const canVote = role === "arbitrator";
  const canChallenge = role === "client" || role === "freelancer";

  return (
    <Protected>
      <DashboardShell>
        <section className="space-y-6">
          <PageIntro title="Dispute Workspace" subtitle="Review evidence, arbitrator votes, and settlement outcomes in realtime." />

          {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}
          {loading ? <p className="text-sm text-[#4b4b4b]">Loading dispute...</p> : null}

          {detail ? (
            <>
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold">Dispute {detail.dispute.id}</h2>
                    <p className="text-sm text-[#4b4b4b]">Type: {detail.dispute.dispute_type}</p>
                  </div>
                  <div className="flex gap-2">
                    <Pill text={detail.dispute.status} />
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
                  <Button asChild>
                    <Link href={detail.submission.github_pr_url} target="_blank">Open PR</Link>
                  </Button>
                </div>
              </Card>

              <Card>
                <h3 className="text-lg font-semibold">Current Votes</h3>
                <div className="mt-3 space-y-2">
                  {detail.votes.map((entry) => (
                    <div key={entry.arbitrator_id} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                      <p className="text-sm font-medium">Arbitrator {entry.arbitrator_id}</p>
                      <p className="text-xs text-[#4b4b4b]">Vote: {entry.vote ?? (entry.has_voted ? "submitted" : "pending")}</p>
                    </div>
                  ))}
                </div>
              </Card>

              {canVote ? (
                <Card>
                  <h3 className="text-lg font-semibold">Cast Vote</h3>
                  <form className="mt-3 space-y-3" onSubmit={onVote}>
                    <Select value={vote} onChange={(event) => setVote(event.target.value as "freelancer_wins" | "client_wins" | "split")}>
                      <option value="freelancer_wins">Freelancer Wins</option>
                      <option value="client_wins">Client Wins</option>
                      <option value="split">Split</option>
                    </Select>
                    <Textarea
                      rows={4}
                      value={justification}
                      onChange={(event) => setJustification(event.target.value)}
                      placeholder="Minimum 50 characters"
                      required
                    />
                    <Button type="submit" disabled={voting}>
                      {voting ? "Submitting..." : "Submit Vote"}
                    </Button>
                  </form>
                </Card>
              ) : null}

              {canChallenge ? (
                <Card>
                  <h3 className="text-lg font-semibold">Challenge Arbitrator</h3>
                  <form className="mt-3 space-y-3" onSubmit={onChallenge}>
                    <Select value={challengeArbitratorId} onChange={(event) => setChallengeArbitratorId(event.target.value)}>
                      <option value="">Select arbitrator</option>
                      {arbitrationOptions.map((id) => (
                        <option key={id} value={id}>{id}</option>
                      ))}
                    </Select>
                    <Input
                      value={challengeReason}
                      onChange={(event) => setChallengeReason(event.target.value)}
                      placeholder="Challenge reason"
                      minLength={50}
                      required
                    />
                    <Button type="submit" disabled={challenging || !challengeArbitratorId}>
                      {challenging ? "Submitting..." : "Challenge"}
                    </Button>
                  </form>
                </Card>
              ) : null}
            </>
          ) : null}
        </section>
      </DashboardShell>
    </Protected>
  );
}
