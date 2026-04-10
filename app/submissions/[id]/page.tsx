"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  createSubmissionReviewCommentRequest,
  flagSubmissionScoreRequest,
  getSubmissionRequest,
  openDisputeRequest,
  submitSubmissionReviewDecisionRequest,
} from "../../../lib/api";
import { useRealtimeChannel } from "../../../lib/realtime-client";
import { AppShell } from "../../../src/components/layout/AppShell";
import { Protected } from "../../../components/protected";
import { Button, Card, Input, PageIntro, Pill } from "../../../components/ui/primitives";
import { useAuthStore } from "../../../store/auth-store";

type SubmissionDetail = {
  submission: {
    id: string;
    bounty_id: string;
    status: string;
    ci_status: string;
    ci_run_id: string | null;
    github_pr_url: string;
    ai_score: number | null;
    final_score: number | null;
    score_finalized_at: string | null;
    client_flagged_at: string | null;
    stage?: string;
    review_gate_status?: string;
    review_window_ends_at?: string | null;
    approved_for_payout_at?: string | null;
    last_client_comment?: string | null;
  };
  bounty: {
    id: string;
    title: string;
  };
  payout: {
    id: string | null;
    status: string | null;
    expected_amount: string | null;
    actual_amount: string | null;
    tx_id: string | null;
    mismatch_flagged: boolean | null;
  };
  disputes: Array<{
    id: string;
    status: string;
    outcome: string | null;
    dispute_type: string;
    raised_at: string;
  }>;
  review_comments?: Array<{
    id: string;
    content: string;
    comment_type: string;
    author_name: string;
    created_at: string;
    parent_comment_id?: string | null;
  }>;
  feedback_reports?: Array<{
    id: string;
    client_summary: string;
    freelancer_summary: string;
    implemented_items: string[];
    missing_items: string[];
    freelancer_suggestions: string[];
    client_comment?: string | null;
    created_at: string;
  }>;
};

export default function SubmissionDetailPage() {
  const params = useParams<{ id: string }>();
  const submissionId = params.id;
  const { token, hydrate } = useAuthStore();

  const [detail, setDetail] = useState<SubmissionDetail | null>(null);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [flagging, setFlagging] = useState(false);
  const [openingDispute, setOpeningDispute] = useState(false);
  const [disputeReason, setDisputeReason] = useState("");
  const [disputeType, setDisputeType] = useState<"score_unfair" | "quality_low" | "requirement_mismatch" | "fraud" | "non_delivery">("score_unfair");
  const [reviewComment, setReviewComment] = useState("");
  const [reviewDecision, setReviewDecision] = useState<"approve" | "request_changes" | "reject">("request_changes");
  const [decisionComment, setDecisionComment] = useState("");
  const [postingReviewComment, setPostingReviewComment] = useState(false);
  const [submittingDecision, setSubmittingDecision] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const load = useCallback(async () => {
    if (!token || !submissionId) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = (await getSubmissionRequest(token, submissionId)) as SubmissionDetail;
      setDetail(response);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [submissionId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const bountyId = detail?.submission.bounty_id;

  const realtime = useRealtimeChannel({
    token,
    bountyId,
    onEvent: (eventName) => {
      if (eventName === "bounty:scored" || eventName === "bounty:payout_released" || eventName === "bounty:ci_passed") {
        void load();
      }
    },
  });

  async function onFlagScore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !submissionId) {
      return;
    }

    setFlagging(true);
    setError(null);

    try {
      await flagSubmissionScoreRequest(token, submissionId, reason);
      setReason("");
      await load();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setFlagging(false);
    }
  }

  async function onOpenDispute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !submissionId) {
      return;
    }

    setOpeningDispute(true);
    setError(null);

    try {
      const response = (await openDisputeRequest(token, {
        submission_id: submissionId,
        reason: disputeReason.trim(),
        dispute_type: disputeType,
      })) as { dispute_id: string };

      setDisputeReason("");
      await load();
      window.location.href = `/disputes/${response.dispute_id}`;
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setOpeningDispute(false);
    }
  }

  async function onPostReviewComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !submissionId) {
      return;
    }

    const content = reviewComment.trim();
    if (content.length < 2) {
      setError("Review comment must have at least 2 characters.");
      return;
    }

    setPostingReviewComment(true);
    setError(null);
    try {
      await createSubmissionReviewCommentRequest(token, submissionId, {
        content,
        commentType: "note",
        visibility: "both",
      });
      setReviewComment("");
      await load();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setPostingReviewComment(false);
    }
  }

  async function onSubmitReviewDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !submissionId) {
      return;
    }

    const comment = decisionComment.trim();
    if (comment.length < 2) {
      setError("Decision comment must have at least 2 characters.");
      return;
    }

    setSubmittingDecision(true);
    setError(null);
    try {
      await submitSubmissionReviewDecisionRequest(token, submissionId, {
        decision: reviewDecision,
        comment,
      });
      setDecisionComment("");
      await load();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setSubmittingDecision(false);
    }
  }

  return (
    <Protected>
      <AppShell>
        <section className="space-y-6">
          <PageIntro title="Submission Details" subtitle="Review CI, scoring, payout, and dispute state for this submission." />

          {realtime.state === "reconnecting" ? (
            <Card>
              <p className="text-sm text-[#8f1515]">Realtime reconnecting. Latest state may be delayed.</p>
            </Card>
          ) : null}

          {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}
          {loading ? <p className="text-sm text-[#4b4b4b]">Loading submission...</p> : null}

          {detail ? (
            <>
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold">{detail.bounty.title}</h2>
                    <p className="text-xs text-[#4b4b4b]">Submission {detail.submission.id}</p>
                  </div>
                  <Pill text={detail.submission.status} />
                </div>
                <div className="mt-4 grid gap-2 text-sm text-[#4b4b4b] md:grid-cols-2">
                  <p>CI: {detail.submission.ci_status}</p>
                  <p>CI Run ID: {detail.submission.ci_run_id ?? "n/a"}</p>
                  <p>AI Score: {detail.submission.ai_score ?? "n/a"}</p>
                  <p>Final Score: {detail.submission.final_score ?? "n/a"}</p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button asChild variant="secondary">
                    <Link href={detail.submission.github_pr_url} target="_blank">Open PR</Link>
                  </Button>
                  <Button asChild>
                    <Link href={`/bounties/${detail.submission.bounty_id}`}>Open Bounty</Link>
                  </Button>
                </div>
              </Card>

              <Card>
                <h3 className="text-lg font-semibold">Payout</h3>
                <div className="mt-3 grid gap-2 text-sm text-[#4b4b4b] md:grid-cols-2">
                  <p>Status: {detail.payout.status ?? "n/a"}</p>
                  <p>Expected: {detail.payout.expected_amount ?? "n/a"}</p>
                  <p>Actual: {detail.payout.actual_amount ?? "n/a"}</p>
                  <p>Tx ID: {detail.payout.tx_id ?? "n/a"}</p>
                </div>
                {detail.payout.mismatch_flagged ? (
                  <p className="mt-3 text-sm text-[#8f1515]">Payout mismatch was flagged and queued for admin review.</p>
                ) : null}
              </Card>

              <Card>
                <h3 className="text-lg font-semibold">Review Workflow</h3>
                <div className="mt-3 grid gap-2 text-sm text-[#4b4b4b] md:grid-cols-2">
                  <p>Submission Stage: {detail.submission.stage ?? "n/a"}</p>
                  <p>Review Gate: {detail.submission.review_gate_status ?? "none"}</p>
                  <p>Review Window Ends: {detail.submission.review_window_ends_at ? new Date(detail.submission.review_window_ends_at).toLocaleString() : "n/a"}</p>
                  <p>Payout Approved At: {detail.submission.approved_for_payout_at ? new Date(detail.submission.approved_for_payout_at).toLocaleString() : "n/a"}</p>
                </div>

                {detail.feedback_reports?.[0] ? (
                  <div className="mt-4 rounded-xl border border-[#121212] bg-[#f5f5f5] p-3 text-sm">
                    <p className="font-medium text-[#121212]">Latest Comparison Summary</p>
                    <p className="mt-1 text-[#4b4b4b]">For client: {detail.feedback_reports[0].client_summary}</p>
                    <p className="mt-1 text-[#4b4b4b]">For freelancer: {detail.feedback_reports[0].freelancer_summary}</p>
                    {(detail.feedback_reports[0].implemented_items ?? []).length > 0 ? (
                      <p className="mt-2 text-[#4b4b4b]">Implemented: {(detail.feedback_reports[0].implemented_items ?? []).join(", ")}</p>
                    ) : null}
                    {(detail.feedback_reports[0].missing_items ?? []).length > 0 ? (
                      <p className="mt-2 text-[#8a5a00]">Missing: {(detail.feedback_reports[0].missing_items ?? []).join(", ")}</p>
                    ) : null}
                    {(detail.feedback_reports[0].freelancer_suggestions ?? []).length > 0 ? (
                      <p className="mt-2 text-[#4b4b4b]">Suggestions: {(detail.feedback_reports[0].freelancer_suggestions ?? []).join(" | ")}</p>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-4 space-y-2">
                  <p className="text-sm font-semibold">Review Comments</p>
                  {detail.review_comments?.map((comment) => (
                    <div key={comment.id} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                      <p className="text-xs text-[#4b4b4b]">{comment.author_name} • {new Date(comment.created_at).toLocaleString()} • {comment.comment_type}</p>
                      <p className="mt-1 text-sm text-[#121212]">{comment.content}</p>
                    </div>
                  ))}
                  {(detail.review_comments?.length ?? 0) === 0 ? (
                    <p className="text-sm text-[#4b4b4b]">No review comments yet.</p>
                  ) : null}
                </div>

                <form className="mt-4 space-y-2 border-t border-[#121212] pt-4" onSubmit={onPostReviewComment}>
                  <p className="text-sm font-semibold">Add Review Comment</p>
                  <Input
                    value={reviewComment}
                    onChange={(event) => setReviewComment(event.target.value)}
                    placeholder="Share update, clarification, or feedback"
                    minLength={2}
                    required
                  />
                  <Button type="submit" disabled={postingReviewComment}>
                    {postingReviewComment ? "Posting..." : "Post Comment"}
                  </Button>
                </form>

                <form className="mt-4 space-y-2 border-t border-[#121212] pt-4" onSubmit={onSubmitReviewDecision}>
                  <p className="text-sm font-semibold">Client Decision</p>
                  <select
                    className="w-full rounded-none border-2 border-[#121212] bg-white px-3 py-2.5 text-sm"
                    value={reviewDecision}
                    onChange={(event) => setReviewDecision(event.target.value as "approve" | "request_changes" | "reject")}
                  >
                    <option value="approve">Approve</option>
                    <option value="request_changes">Request Changes</option>
                    <option value="reject">Reject</option>
                  </select>
                  <Input
                    value={decisionComment}
                    onChange={(event) => setDecisionComment(event.target.value)}
                    placeholder="Add decision comment"
                    minLength={2}
                    required
                  />
                  <Button type="submit" disabled={submittingDecision}>
                    {submittingDecision ? "Submitting..." : "Submit Decision"}
                  </Button>
                </form>
              </Card>

              <Card>
                <h3 className="text-lg font-semibold">Flag AI Score</h3>
                <p className="mt-1 text-sm text-[#4b4b4b]">Allowed within 48 hours after score publication.</p>
                <form className="mt-3 space-y-3" onSubmit={onFlagScore}>
                  <Input
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Reason for challenge"
                    minLength={20}
                    required
                  />
                  <Button type="submit" disabled={flagging}>
                    {flagging ? "Submitting..." : "Flag Score"}
                  </Button>
                </form>

                <form className="mt-5 space-y-3 border-t border-[#121212] pt-4" onSubmit={onOpenDispute}>
                  <p className="text-sm font-semibold">Open Dispute</p>
                  <select
                    className="w-full rounded-none border-2 border-[#121212] bg-white px-3 py-2.5 text-sm"
                    value={disputeType}
                    onChange={(event) => setDisputeType(event.target.value as "score_unfair" | "quality_low" | "requirement_mismatch" | "fraud" | "non_delivery")}
                  >
                    <option value="score_unfair">Score unfair</option>
                    <option value="quality_low">Quality low</option>
                    <option value="requirement_mismatch">Requirement mismatch</option>
                    <option value="fraud">Fraud</option>
                    <option value="non_delivery">Non delivery</option>
                  </select>
                  <Input
                    value={disputeReason}
                    onChange={(event) => setDisputeReason(event.target.value)}
                    placeholder="Minimum 100 characters"
                    minLength={100}
                    required
                  />
                  <Button type="submit" disabled={openingDispute}>
                    {openingDispute ? "Opening..." : "Open Dispute"}
                  </Button>
                </form>
              </Card>

              <Card>
                <h3 className="text-lg font-semibold">Disputes</h3>
                <div className="mt-3 space-y-2">
                  {detail.disputes.map((dispute) => (
                    <div key={dispute.id} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                      <p className="font-medium">{dispute.dispute_type}</p>
                      <p className="text-xs text-[#4b4b4b]">{dispute.status} {dispute.outcome ? `| ${dispute.outcome}` : ""}</p>
                      <Button asChild className="mt-2 h-8 px-3 text-xs">
                        <Link href={`/disputes/${dispute.id}`}>Open Dispute</Link>
                      </Button>
                    </div>
                  ))}
                  {detail.disputes.length === 0 ? <p className="text-sm text-[#4b4b4b]">No disputes filed for this submission.</p> : null}
                </div>
              </Card>
            </>
          ) : null}
        </section>
      </AppShell>
    </Protected>
  );
}
