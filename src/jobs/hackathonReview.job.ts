import { inngest } from "./aiScoring.job";
import {
  generateHackathonCodeReview,
  loadHackathonReviewContext,
  persistHackathonCodeReview,
  recordHackathonTransferEvidence,
  upsertHackathonScore,
  ensureHackathonCoinLock,
  type HackathonReviewInput,
  type HackathonCodeReviewResult,
} from "../services/hackathonReview.service";

interface HackathonReviewEvent {
  data: {
    submission_id: string;
    bounty_id: string;
    reviewer_id: string;
    action: "rate_decide" | "approve_review";
    decision: "approve" | "request_changes" | "reject";
    client_rating?: number;
    comment?: string;
  };
}

export const hackathonReviewJob = inngest.createFunction(
  {
    id: "hackathon_review_pipeline",
    retries: 2,
    name: "Hackathon Review Pipeline",
  },
  { event: "hackathon/review_requested" },
  async (context) => {
    const event = context.event as HackathonReviewEvent;
    const input: HackathonReviewInput = {
      submissionId: event.data.submission_id,
      bountyId: event.data.bounty_id,
      reviewerId: event.data.reviewer_id,
      action: event.data.action,
      decision: event.data.decision,
      clientRating: event.data.client_rating,
      comment: event.data.comment,
    };

    const loaded = await context.step.run("load_review_context", async () => {
      return loadHackathonReviewContext(input);
    });

    const review = await context.step.run("generate_code_review", async () => {
      return generateHackathonCodeReview(loaded, input);
    });

    await context.step.run("persist_review_records", async () => {
      await persistHackathonCodeReview(loaded, input, review as HackathonCodeReviewResult);
    });

    const score = await context.step.run("upsert_hackathon_score", async () => {
      return upsertHackathonScore(loaded, review as HackathonCodeReviewResult);
    });

    const lockTxId = await context.step.run("ensure_coin_lock", async () => {
      return ensureHackathonCoinLock(loaded);
    });

    const transferTxId = await context.step.run("record_transfer_evidence", async () => {
      return recordHackathonTransferEvidence(loaded, input);
    });

    return {
      ok: true,
      score,
      lock_tx_id: lockTxId,
      transfer_tx_id: transferTxId,
      review_source: review.source,
    };
  },
);
