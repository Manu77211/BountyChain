"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { acceptBountyRequest, getBountyRequest } from "../../../lib/api";
import { useRealtimeChannel } from "../../../lib/realtime-client";
import { DashboardShell } from "../../../components/dashboard-shell";
import { Protected } from "../../../components/protected";
import { Button, Card, Input, PageIntro, Pill } from "../../../components/ui/primitives";
import { useAuthStore } from "../../../store/auth-store";

type BountyDetail = {
  id: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  creator_id: string;
  repo_url: string;
  target_branch: string;
  allowed_languages: string[];
  total_amount: string;
  scoring_mode: string;
  ai_score_threshold: number;
  max_freelancers: number;
  status: string;
  deadline: string;
};

type SyncedSubmission = {
  id: string;
  status: string;
  bounty_id: string;
  ci_status?: string;
};

type SyncedDispute = {
  id: string;
  status: string;
  outcome?: string | null;
};

export default function BountyDetailPage() {
  const params = useParams<{ id: string }>();
  const bountyId = params.id;
  const { token, user, hydrate } = useAuthStore();

  const [bounty, setBounty] = useState<BountyDetail | null>(null);
  const [submissions, setSubmissions] = useState<SyncedSubmission[]>([]);
  const [disputes, setDisputes] = useState<SyncedDispute[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [prUrl, setPrUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [repoId, setRepoId] = useState("");

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const loadBounty = useCallback(async () => {
    if (!bountyId) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = (await getBountyRequest(bountyId)) as { bounty: BountyDetail };
      setBounty(response.bounty);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [bountyId]);

  useEffect(() => {
    void loadBounty();
  }, [loadBounty]);

  const realtime = useRealtimeChannel({
    token,
    bountyId,
    onSyncState: (payload) => {
      const nextBounty = payload.bounty as BountyDetail | undefined;
      const nextSubmissions = payload.submissions as SyncedSubmission[] | undefined;
      const nextDisputes = payload.disputes as SyncedDispute[] | undefined;

      if (nextBounty) {
        setBounty(nextBounty);
      }
      setSubmissions(nextSubmissions ?? []);
      setDisputes(nextDisputes ?? []);
    },
    onEvent: () => {
      void loadBounty();
    },
  });

  const canAccept = useMemo(() => {
    if (!user || !bounty) {
      return false;
    }

    const role = String(user.role).toLowerCase();
    return role === "freelancer" && bounty.status === "open";
  }, [bounty, user]);

  async function onAccept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !bounty) {
      return;
    }

    setAccepting(true);
    setError(null);

    try {
      await acceptBountyRequest(token, bounty.id, {
        github_pr_url: prUrl.trim(),
        github_branch: branch.trim(),
        github_repo_id: Number(repoId),
      });
      setPrUrl("");
      setRepoId("");
      await loadBounty();
      realtime.requestSync();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setAccepting(false);
    }
  }

  return (
    <Protected>
      <DashboardShell>
        <section className="space-y-6">
          <PageIntro title="Bounty Details" subtitle="Track CI, scoring, payout, and disputes in realtime." />

          {realtime.state === "reconnecting" ? (
            <Card>
              <p className="text-sm text-[#8f1515]">Reconnecting to realtime updates...</p>
            </Card>
          ) : null}

          {realtime.state === "unauthorized" ? (
            <Card>
              <p className="text-sm text-[#8f1515]">Realtime session expired. Please sign in again.</p>
            </Card>
          ) : null}

          {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}
          {loading ? <p className="text-sm text-[#4b4b4b]">Loading bounty...</p> : null}

          {bounty ? (
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-semibold">{bounty.title}</h2>
                  <p className="mt-1 text-sm text-[#4b4b4b]">{bounty.description}</p>
                </div>
                <Pill text={bounty.status} />
              </div>
              <div className="mt-4 grid gap-3 text-sm text-[#4b4b4b] md:grid-cols-2">
                <p>Repo: {bounty.repo_url}</p>
                <p>Branch: {bounty.target_branch}</p>
                <p>Scoring: {bounty.scoring_mode}</p>
                <p>Threshold: {bounty.ai_score_threshold}</p>
                <p>Amount: {bounty.total_amount} microALGO</p>
                <p>Deadline: {new Date(bounty.deadline).toLocaleString()}</p>
              </div>
              <div className="mt-4 rounded-xl border border-[#121212] bg-[#f5f5f5] p-3 text-sm text-[#2a2a2a]">
                {bounty.acceptance_criteria}
              </div>
            </Card>
          ) : null}

          {canAccept ? (
            <Card>
              <h3 className="text-lg font-semibold">Accept This Bounty</h3>
              <form className="mt-3 grid gap-3 md:grid-cols-3" onSubmit={onAccept}>
                <Input placeholder="GitHub PR URL" value={prUrl} onChange={(event) => setPrUrl(event.target.value)} required />
                <Input placeholder="Git branch" value={branch} onChange={(event) => setBranch(event.target.value)} required />
                <Input placeholder="GitHub repo numeric ID" value={repoId} onChange={(event) => setRepoId(event.target.value)} required />
                <div className="md:col-span-3">
                  <Button type="submit" disabled={accepting}>
                    {accepting ? "Accepting..." : "Accept Bounty"}
                  </Button>
                </div>
              </form>
            </Card>
          ) : null}

          <Card>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-lg font-semibold">Submissions</h3>
              <Button variant="secondary" onClick={realtime.requestSync}>Refresh State</Button>
            </div>
            <div className="mt-3 space-y-2">
              {submissions.map((submission) => (
                <div key={submission.id} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                  <p className="font-medium">Submission {submission.id.slice(0, 8)}</p>
                  <p className="text-xs text-[#4b4b4b]">Status {submission.status} | CI {submission.ci_status ?? "n/a"}</p>
                  <Button asChild className="mt-2 h-8 px-3 text-xs">
                    <Link href={`/submissions/${submission.id}`}>Open Submission</Link>
                  </Button>
                </div>
              ))}
              {submissions.length === 0 ? <p className="text-sm text-[#4b4b4b]">No synced submissions yet.</p> : null}
            </div>
          </Card>

          <Card>
            <h3 className="text-lg font-semibold">Disputes</h3>
            <div className="mt-3 space-y-2">
              {disputes.map((dispute) => (
                <div key={dispute.id} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                  <p className="font-medium">Dispute {dispute.id.slice(0, 8)}</p>
                  <p className="text-xs text-[#4b4b4b]">Status {dispute.status} {dispute.outcome ? `| ${dispute.outcome}` : ""}</p>
                  <Button asChild className="mt-2 h-8 px-3 text-xs">
                    <Link href={`/disputes/${dispute.id}`}>Open Dispute</Link>
                  </Button>
                </div>
              ))}
              {disputes.length === 0 ? <p className="text-sm text-[#4b4b4b]">No disputes for this bounty.</p> : null}
            </div>
          </Card>
        </section>
      </DashboardShell>
    </Protected>
  );
}
