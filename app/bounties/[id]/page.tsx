"use client";

import * as Tabs from "@radix-ui/react-tabs";
import confetti from "canvas-confetti";
import { Code2, Copy, Loader2, Share2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { io, type Socket } from "socket.io-client";
import { MilestoneList } from "../../../components/bounties/MilestoneList";
import { SubmissionCard } from "../../../components/bounties/SubmissionCard";
import { Protected } from "../../../components/protected";
import { Button, Card } from "../../../components/ui/primitives";
import {
  SOCKET_BASE_URL,
  acceptBountyRequest,
  cancelBountyRequest,
  extendBountyDeadlineRequest,
  flagSubmissionScoreRequest,
  getBountyContextRequest,
  getBountyRequest,
  openDisputeRequest,
  retriggerSubmissionCiRequest,
} from "../../../lib/api";
import { useAuthStore } from "../../../store/auth-store";
import { AppShell } from "../../../src/components/layout/AppShell";

type Bounty = {
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
  extension_count: number;
  escrow_locked: boolean;
  created_at: string;
  updated_at: string;
};

type Submission = {
  id: string;
  freelancer_id: string;
  freelancer_wallet_address: string;
  freelancer_email: string | null;
  submission_received_at: string;
  ci_status: string;
  ci_run_id: string | null;
  ci_retrigger_count: number;
  github_pr_url: string;
  github_branch: string;
  ai_score: number | null;
  ai_score_raw: Record<string, unknown> | null;
  ai_language_mismatch_flag: boolean;
  ai_integrity_flag: boolean;
  final_score: number | null;
  status: string;
  payout_status: string | null;
  payout_hold_reason: string | null;
  score_finalized_at: string | null;
  client_flagged_at: string | null;
  dispute_id: string | null;
};

type Milestone = {
  id: string;
  title: string;
  description: string;
  payout_amount: string;
  order_index: number;
  status: "pending" | "unlocked" | "paid" | "failed";
  payout_tx_id: string | null;
};

type ActivityItem = {
  key: string;
  label: string;
  at: string;
  detail?: string;
};

function timeAgo(value: string) {
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function remaining(deadline: string) {
  const ms = new Date(deadline).getTime() - Date.now();
  if (ms <= 0) {
    return "Expired";
  }
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${minutes}m left`;
}

function splitCriteria(criteria: string) {
  return criteria
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export default function BountyDetailPage() {
  const params = useParams<{ id: string }>();
  const bountyId = params.id;
  const { token, user, hydrate } = useAuthStore();

  const [bounty, setBounty] = useState<Bounty | null>(null);
  const [creatorWallet, setCreatorWallet] = useState<string>("");
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [submissionsCount, setSubmissionsCount] = useState(0);
  const [activeSubmissionCount, setActiveSubmissionCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [acceptModalOpen, setAcceptModalOpen] = useState(false);
  const [acceptChecklist, setAcceptChecklist] = useState({ criteria: false, deadline: false });
  const [acceptPrUrl, setAcceptPrUrl] = useState("");
  const [acceptBranch, setAcceptBranch] = useState("main");
  const [acceptRepoId, setAcceptRepoId] = useState("1");
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const isClient = String(user?.role ?? "").toLowerCase() === "client";
  const isFreelancer = String(user?.role ?? "").toLowerCase() === "freelancer";
  const isCreator = bounty ? user?.id === bounty.creator_id : false;

  const mySubmission = useMemo(
    () => submissions.find((item) => item.freelancer_id === user?.id),
    [submissions, user?.id],
  );

  const hasMilestones = milestones.length > 0;

  async function loadBounty() {
    if (!bountyId || !token) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [detail, context] = await Promise.all([
        getBountyRequest(bountyId),
        getBountyContextRequest(token, bountyId),
      ]);

      const detailBounty = detail.bounty as Bounty;
      setBounty(detailBounty);
      setCreatorWallet(context.creator?.wallet_address ?? detailBounty.creator_id);
      setSubmissions((context.submissions ?? []) as Submission[]);
      setMilestones((context.milestones ?? []) as Milestone[]);
      setActivity((context.activity ?? []) as ActivityItem[]);
      setSubmissionsCount(context.submissions_count ?? 0);
      setActiveSubmissionCount(context.active_submission_count ?? 0);
      setAcceptBranch(detailBounty.target_branch || "main");
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadBounty();
  }, [bountyId, token]);

  useEffect(() => {
    if (!bountyId || !token) {
      return;
    }

    const socket: Socket = io(SOCKET_BASE_URL, {
      transports: ["websocket"],
      auth: { token },
    });

    socket.on("connect", () => {
      socket.emit("join", `bounty:${bountyId}`);
    });

    socket.on("bounty:ci_running", (payload: { submission_id: string; ci_status: string }) => {
      setSubmissions((prev) =>
        prev.map((item) =>
          item.id === payload.submission_id ? { ...item, ci_status: payload.ci_status } : item,
        ),
      );
    });

    socket.on("bounty:ci_passed", (payload: { submission_id: string; ci_status: string }) => {
      setSubmissions((prev) =>
        prev.map((item) =>
          item.id === payload.submission_id ? { ...item, ci_status: payload.ci_status } : item,
        ),
      );
      setToast("CI passed. AI scoring started.");
    });

    socket.on("bounty:ci_failed", (payload: { submission_id: string; ci_status: string }) => {
      setSubmissions((prev) =>
        prev.map((item) =>
          item.id === payload.submission_id ? { ...item, ci_status: payload.ci_status } : item,
        ),
      );
      setStatusBanner("CI failure detected. Submission status was updated.");
    });

    socket.on("bounty:scoring", () => {
      setToast("AI scoring in progress...");
    });

    socket.on("bounty:scored", (payload: { submission_id: string; ai_score: number; final_score: number }) => {
      setSubmissions((prev) =>
        prev.map((item) =>
          item.id === payload.submission_id
            ? { ...item, ai_score: payload.ai_score, final_score: payload.final_score }
            : item,
        ),
      );
    });

    socket.on("bounty:payout_released", () => {
      setToast("Payout Sent!");
      void confetti({ particleCount: 100, spread: 70, origin: { y: 0.65 } });
      void loadBounty();
    });

    socket.on("bounty:disputed", () => {
      setStatusBanner("A dispute has been opened for this bounty.");
      void loadBounty();
    });

    return () => {
      socket.emit("leave", `bounty:${bountyId}`);
      socket.disconnect();
    };
  }, [bountyId, token]);

  async function onAcceptSubmission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !bounty) {
      return;
    }

    setAccepting(true);
    setError(null);

    try {
      await acceptBountyRequest(token, bounty.id, {
        github_pr_url: acceptPrUrl.trim(),
        github_branch: acceptBranch.trim(),
        github_repo_id: Number(acceptRepoId),
      });
      setAcceptModalOpen(false);
      setToast("Accepted. You can now work on this bounty.");
      await loadBounty();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setAccepting(false);
    }
  }

  async function onFlagScore(submissionId: string) {
    if (!token) {
      return;
    }

    try {
      await flagSubmissionScoreRequest(token, submissionId, "Needs manual verification");
      setToast("Score flagged for review.");
      await loadBounty();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }

  async function onOpenDispute(submissionId: string) {
    if (!token) {
      return;
    }

    try {
      await openDisputeRequest(token, {
        submission_id: submissionId,
        dispute_type: "score_unfair",
        reason: "I want this score and payout outcome reviewed.",
      });
      setToast("Dispute opened.");
      await loadBounty();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }

  async function onRetriggerCi(submissionId: string) {
    if (!token) {
      return;
    }

    try {
      await retriggerSubmissionCiRequest(token, submissionId);
      setToast("CI re-triggered.");
      await loadBounty();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }

  async function onExtendDeadline() {
    if (!token || !bounty) {
      return;
    }

    const next = new Date(new Date(bounty.deadline).getTime() + 24 * 60 * 60 * 1000).toISOString();

    try {
      await extendBountyDeadlineRequest(token, bounty.id, next);
      await loadBounty();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }

  async function onCancelBounty() {
    if (!token || !bounty) {
      return;
    }

    try {
      await cancelBountyRequest(token, bounty.id);
      await loadBounty();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }

  async function copyShareLink() {
    await navigator.clipboard.writeText(window.location.href);
    setToast("Link copied.");
  }

  const canAccept = isFreelancer && bounty?.status === "open" && !mySubmission && !isCreator;
  const takenSingleSlot = Boolean(bounty && bounty.max_freelancers === 1 && activeSubmissionCount >= 1);
  const canDispute = Boolean(
    mySubmission &&
      Date.now() - new Date(mySubmission.submission_received_at).getTime() <= 72 * 60 * 60 * 1000,
  );

  return (
    <Protected>
      <AppShell>
        <section className="space-y-5">
          {toast ? <div className="border border-[#1040c0] bg-[#eef5ff] p-2 text-xs text-[#1040c0]">{toast}</div> : null}
          {statusBanner ? <div className="border border-[#be8b00] bg-[#fff4d6] p-2 text-xs text-[#7a5a00]">{statusBanner}</div> : null}
          {error ? <div className="border border-[#8f1515] bg-[#ffe7e7] p-2 text-xs text-[#8f1515]">{error}</div> : null}

          {loading ? (
            <Card>
              <p className="flex items-center gap-1 text-sm"><Loader2 size={16} className="animate-spin" /> Loading bounty...</p>
            </Card>
          ) : null}

          {bounty ? (
            <div className="flex flex-col gap-6 lg:flex-row">
              <div className="min-w-0 flex-1 space-y-5">
                <Card className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="border border-[#121212] bg-[#f0c020] px-2 py-1 text-xs font-semibold uppercase">{bounty.status}</span>
                    <span className="border border-[#121212] bg-[#eef5ff] px-2 py-1 text-xs font-semibold uppercase">{bounty.scoring_mode}</span>
                  </div>
                  <h1 className="text-3xl font-bold text-[#121212]">{bounty.title}</h1>

                  <div className="flex flex-wrap items-center gap-3 text-xs text-[#4b4b4b]">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full border border-[#121212] bg-[#f3f3f3] text-[10px] font-black">
                        {creatorWallet.slice(0, 2)}
                      </div>
                      <span>{creatorWallet} - Posted {timeAgo(bounty.created_at)}</span>
                    </div>
                    <span className="text-sm font-black text-[#6e5a00]">{Number(bounty.total_amount) / 1_000_000} ALGO</span>
                    <span className="rounded border border-[#121212] bg-[#f8f8f8] px-2 py-1">{remaining(bounty.deadline)}</span>
                    <button type="button" className="inline-flex items-center gap-1 underline" onClick={() => void copyShareLink()}>
                      <Share2 size={14} /> Share <Copy size={12} />
                    </button>
                    <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                      <Link href={`/dashboard/chat/${bounty.id}`}>Open Bounty Chat</Link>
                    </Button>
                  </div>
                </Card>

                <Tabs.Root defaultValue="overview">
                  <Tabs.List className="flex flex-wrap border-b-2 border-[#121212]">
                    {[
                      ["overview", "Overview"],
                      ["requirements", "Requirements"],
                      ["submissions", "Submissions"],
                      ["activity", "Activity"],
                      ...(hasMilestones ? [["milestones", "Milestones"]] : []),
                    ].map(([value, label]) => (
                      <Tabs.Trigger
                        key={value}
                        value={value}
                        className="border-b-2 border-transparent px-3 py-2 text-sm font-semibold data-[state=active]:border-[#1040c0]"
                      >
                        {label}
                      </Tabs.Trigger>
                    ))}
                  </Tabs.List>

                  <Tabs.Content value="overview" className="mt-4 space-y-4">
                    <Card>
                      <article className="prose prose-invert max-w-none text-sm prose-p:text-[#3e3e3e] prose-strong:text-[#121212]">
                        <ReactMarkdown>{bounty.description}</ReactMarkdown>
                      </article>
                    </Card>
                    <Card className="space-y-2">
                      <p className="text-sm font-semibold">Allowed Languages</p>
                      <div className="flex flex-wrap gap-2">
                        {bounty.allowed_languages.map((language) => (
                          <span key={language} className="border border-[#121212] bg-[#f4f4f4] px-2 py-1 text-xs">
                            {language}
                          </span>
                        ))}
                      </div>
                      <p className="text-xs text-[#4b4b4b]">AI threshold: {bounty.ai_score_threshold}</p>
                      <a href={bounty.repo_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs underline">
                        <Code2 size={14} /> {bounty.repo_url}
                      </a>
                    </Card>
                  </Tabs.Content>

                  <Tabs.Content value="requirements" className="mt-4">
                    <Card className="space-y-2">
                      <p className="text-sm font-semibold">Acceptance Criteria</p>
                      <ol className="list-decimal space-y-1 pl-5 text-sm text-[#3e3e3e]">
                        {splitCriteria(bounty.acceptance_criteria).map((item, index) => (
                          <li key={`${index}-${item}`}>{item}</li>
                        ))}
                      </ol>
                    </Card>
                  </Tabs.Content>

                  <Tabs.Content value="submissions" className="mt-4 space-y-3">
                    {isClient ? (
                      submissions.map((submission) => (
                        <SubmissionCard
                          key={submission.id}
                          submission={submission}
                          aiThreshold={bounty.ai_score_threshold}
                          isClient={isClient}
                          onFlagScore={onFlagScore}
                          onRetriggerCi={onRetriggerCi}
                        />
                      ))
                    ) : null}

                    {!isClient && mySubmission ? (
                      <SubmissionCard
                        submission={mySubmission}
                        aiThreshold={bounty.ai_score_threshold}
                        isClient={false}
                        onFlagScore={onFlagScore}
                        onRetriggerCi={onRetriggerCi}
                      />
                    ) : null}

                    {!isClient && !mySubmission ? (
                      <Card>
                        <p className="text-sm">{submissionsCount} submissions on this bounty.</p>
                      </Card>
                    ) : null}

                    {submissions.length === 0 && submissionsCount === 0 ? (
                      <Card>
                        <p className="text-sm text-[#4b4b4b]">No submissions yet.</p>
                      </Card>
                    ) : null}
                  </Tabs.Content>

                  <Tabs.Content value="activity" className="mt-4">
                    <Card>
                      <div className="space-y-3">
                        {activity.map((item) => (
                          <div key={item.key} className="relative border-l-2 border-[#d0d0d0] pl-4">
                            <span className="absolute -left-[6px] top-[5px] h-2.5 w-2.5 rounded-full bg-[#1040c0]" />
                            <p className="text-sm font-semibold">{item.label}</p>
                            <p className="text-xs text-[#4b4b4b]">{new Date(item.at).toLocaleString()}</p>
                            {item.detail ? <p className="text-xs text-[#4b4b4b]">{item.detail}</p> : null}
                          </div>
                        ))}
                      </div>
                    </Card>
                  </Tabs.Content>

                  {hasMilestones ? (
                    <Tabs.Content value="milestones" className="mt-4">
                      <MilestoneList milestones={milestones} />
                    </Tabs.Content>
                  ) : null}
                </Tabs.Root>
              </div>

              <aside className="w-full lg:sticky lg:top-20 lg:w-[320px]">
                <div className="space-y-4">
                  <Card className="space-y-2">
                    <p className="text-sm font-semibold">Collaboration</p>
                    <p className="text-xs text-[#4b4b4b]">Chat with client/freelancer in the bounty room.</p>
                    <Button asChild className="w-full" variant="secondary">
                      <Link href={`/dashboard/chat/${bounty.id}`}>Open Chat Room</Link>
                    </Button>
                  </Card>

                  {isFreelancer && bounty.status === "open" ? (
                    <Card className="space-y-3">
                      <p className="text-sm font-semibold">Accept & Start Working</p>
                      {isCreator ? (
                        <p className="text-xs text-[#4b4b4b]">You created this bounty.</p>
                      ) : null}
                      {takenSingleSlot ? (
                        <p className="text-xs text-[#8f1515]">This bounty is taken.</p>
                      ) : null}

                      {!isCreator && !takenSingleSlot ? (
                        <>
                          <label className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={acceptChecklist.criteria}
                              onChange={(event) =>
                                setAcceptChecklist((prev) => ({ ...prev, criteria: event.target.checked }))
                              }
                            />
                            Read acceptance criteria
                          </label>
                          <label className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={acceptChecklist.deadline}
                              onChange={(event) =>
                                setAcceptChecklist((prev) => ({ ...prev, deadline: event.target.checked }))
                              }
                            />
                            Confirm you understand the deadline
                          </label>
                          <Button
                            className="w-full"
                            onClick={() => setAcceptModalOpen(true)}
                            disabled={!acceptChecklist.criteria || !acceptChecklist.deadline}
                          >
                            Accept & Start Working
                          </Button>
                        </>
                      ) : null}
                    </Card>
                  ) : null}

                  {isFreelancer && mySubmission ? (
                    <Card className="space-y-2">
                      <p className="text-sm font-semibold">Submission Status</p>
                      <p className="text-xs">CI: {mySubmission.ci_status}</p>
                      <p className="text-xs">AI Score: {mySubmission.ai_score ?? "Pending"}</p>
                      <p className="text-xs">Final Score: {mySubmission.final_score ?? "Pending"}</p>
                      <p className="text-xs">Payout: {mySubmission.payout_status ?? "Pending"}</p>

                      {mySubmission.payout_hold_reason?.toLowerCase().includes("opt") ? (
                        <div className="border border-[#be8b00] bg-[#fff4d6] p-2 text-xs text-[#7a5a00]">
                          You need to opt into the payout asset to receive payment. <a className="underline" href="https://developer.algorand.org/docs/get-details/asa/" target="_blank" rel="noreferrer">How to opt in</a>
                        </div>
                      ) : null}

                      <Button
                        className="w-full"
                        variant="secondary"
                        onClick={() => void onOpenDispute(mySubmission.id)}
                        disabled={!canDispute}
                      >
                        {canDispute ? "Open Dispute" : "Dispute Window Closed"}
                      </Button>
                    </Card>
                  ) : null}

                  {isClient ? (
                    <Card className="space-y-3">
                      <p className="text-sm font-semibold">Bounty Management</p>
                      <Button
                        variant="secondary"
                        className="w-full"
                        disabled={(bounty.extension_count ?? 0) >= 2}
                        onClick={() => void onExtendDeadline()}
                      >
                        Extend Deadline
                      </Button>
                      <Button
                        className="w-full"
                        disabled={activeSubmissionCount > 0}
                        onClick={() => void onCancelBounty()}
                      >
                        Cancel Bounty
                      </Button>
                      <div className="space-y-1 text-xs text-[#4b4b4b]">
                        <p>Submission review list:</p>
                        {submissions.map((item) => (
                          <p key={item.id}>{item.freelancer_wallet_address} - {item.status}</p>
                        ))}
                      </div>
                    </Card>
                  ) : null}
                </div>
              </aside>
            </div>
          ) : null}

          {acceptModalOpen ? (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
              <div className="w-full max-w-lg border-2 border-[#121212] bg-white p-4">
                <p className="text-lg font-semibold">Accept Bounty Terms</p>
                <p className="mt-1 text-xs text-[#4b4b4b]">You confirm the scope and timeline before joining this bounty.</p>

                <form className="mt-4 space-y-3" onSubmit={onAcceptSubmission}>
                  <div>
                    <label className="mb-1 block text-xs font-semibold">PR URL</label>
                    <input
                      className="w-full border-2 border-[#121212] px-3 py-2 text-sm"
                      value={acceptPrUrl}
                      onChange={(event) => setAcceptPrUrl(event.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold">Branch</label>
                    <input
                      className="w-full border-2 border-[#121212] px-3 py-2 text-sm"
                      value={acceptBranch}
                      onChange={(event) => setAcceptBranch(event.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold">GitHub Repo ID</label>
                    <input
                      className="w-full border-2 border-[#121212] px-3 py-2 text-sm"
                      value={acceptRepoId}
                      onChange={(event) => setAcceptRepoId(event.target.value)}
                      required
                    />
                  </div>

                  <div className="flex items-center justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={() => setAcceptModalOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={accepting}>
                      {accepting ? "Accepting..." : "Confirm Accept"}
                    </Button>
                  </div>
                </form>
              </div>
            </div>
          ) : null}
        </section>
      </AppShell>
    </Protected>
  );
}
