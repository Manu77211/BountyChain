import { dbQuery } from "../../../lib/db/client";
import { inngest } from "../client";

export const ciValidationCompatJob = inngest.createFunction(
  {
    id: "ci-validation-compat",
    name: "CI Validation Compatibility Bridge",
    retries: 1,
  },
  { event: "ci_validation/requested" },
  async ({ event, step }) => {
    const row = await step.run("load-ci-compat-context", async () => {
      const rows = await dbQuery<{ ci_status: string; ci_run_id: string | null }>(
        "SELECT ci_status, ci_run_id FROM submissions WHERE id = $1 LIMIT 1",
        [event.data.submission_id],
      );

      return rows.rows[0] ?? null;
    });

    if (!row) {
      return { skipped: true };
    }

    await step.sendEvent("forward-ci-compat-event", {
      name: "submission/ci_completed",
      data: {
        submission_id: event.data.submission_id,
        ci_status:
          row.ci_status === "passed" || row.ci_status === "failed" || row.ci_status === "timeout"
            ? row.ci_status
            : "skipped_abuse",
        skipped_count: 0,
        total_count: 0,
        run_id: row.ci_run_id ?? event.data.delivery_id ?? `compat-${event.data.submission_id}`,
      },
    });

    return { forwarded: true };
  },
);

export const aiScoringCompatJob = inngest.createFunction(
  {
    id: "ai-scoring-compat",
    name: "AI Scoring Compatibility Bridge",
    retries: 1,
  },
  { event: "ai_scoring/requested" },
  async ({ event, step }) => {
    await step.sendEvent("forward-ai-compat-event", {
      name: "submission/scoring_requested",
      data: {
        submission_id: event.data.submission_id,
        bounty_id: event.data.bounty_id,
        scoring_mode: event.data.scoring_mode,
        cached_diff: event.data.cached_diff,
      },
    });

    return { forwarded: true };
  },
);

export const payoutReleaseCompatJob = inngest.createFunction(
  {
    id: "payout-release-compat",
    name: "Payout Release Compatibility Bridge",
    retries: 1,
  },
  { event: "payout_release/requested" },
  async ({ event, step }) => {
    const payout = await step.run("load-payout-compat-context", async () => {
      const rows = await dbQuery<{
        wallet_address: string;
        total_amount: string;
        contributor_splits: Array<Record<string, unknown>>;
      }>(
        `
          SELECT u.wallet_address, b.total_amount, b.contributor_splits
          FROM submissions s
          JOIN users u ON u.id = s.freelancer_id
          JOIN bounties b ON b.id = s.bounty_id
          WHERE s.id = $1
            AND s.bounty_id = $2
          LIMIT 1
        `,
        [event.data.submission_id, event.data.bounty_id],
      );

      return rows.rows[0] ?? null;
    });

    if (!payout) {
      return { skipped: true };
    }

    const splitMap = Array.isArray(payout.contributor_splits)
      ? payout.contributor_splits
          .map((item) => {
            const wallet = typeof item.wallet_address === "string" ? item.wallet_address : null;
            const amount = typeof item.amount === "number" ? item.amount : null;
            return wallet && amount ? { wallet, amount } : null;
          })
          .filter((item): item is { wallet: string; amount: number } => item !== null)
      : [];

    await step.sendEvent("forward-payout-compat-event", {
      name: "payout/release_requested",
      data: {
        submission_id: event.data.submission_id,
        bounty_id: event.data.bounty_id,
        freelancer_wallet: payout.wallet_address,
        amount_micro_algo: Number(payout.total_amount),
        is_split: splitMap.length > 0,
        split_map: splitMap.length > 0 ? splitMap : undefined,
      },
    });

    return { forwarded: true };
  },
);

export const milestoneReleaseCompatJob = inngest.createFunction(
  {
    id: "milestone-release-compat",
    name: "Milestone Release Compatibility Bridge",
    retries: 1,
  },
  { event: "milestone_release/requested" },
  async ({ event, step }) => {
    const milestone = await step.run("load-milestone-compat-context", async () => {
      const rows = await dbQuery<{ payout_amount: string; order_index: number }>(
        "SELECT payout_amount, order_index FROM milestones WHERE id = $1 LIMIT 1",
        [event.data.milestone_id],
      );

      return rows.rows[0] ?? null;
    });

    if (!milestone) {
      return { skipped: true };
    }

    await step.sendEvent("forward-milestone-compat-event", {
      name: "milestone/unlock_requested",
      data: {
        milestone_id: event.data.milestone_id,
        submission_id: event.data.submission_id,
        amount_micro_algo: Number(milestone.payout_amount),
        order_index: milestone.order_index,
      },
    });

    return { forwarded: true };
  },
);

export const disputeResolutionCompatJob = inngest.createFunction(
  {
    id: "dispute-resolution-compat",
    name: "Dispute Resolution Compatibility Bridge",
    retries: 1,
  },
  { event: "dispute_resolution/requested" },
  async ({ event, step }) => {
    await step.sendEvent("forward-dispute-compat-event", {
      name: "dispute/all_votes_in",
      data: {
        dispute_id: event.data.dispute_id,
      },
    });

    return { forwarded: true };
  },
);

export const sendNotificationCompatJob = inngest.createFunction(
  {
    id: "send-notification-compat",
    name: "Notification Compatibility Bridge",
    retries: 1,
  },
  { event: "send_notification/requested" },
  async ({ event, step }) => {
    const channels = Array.isArray(event.data.channels)
      ? event.data.channels
      : event.data.channels
        ? [event.data.channels]
        : event.data.channel === "email"
          ? ["email"]
          : event.data.channel === "in_app"
            ? ["in_app"]
            : ["email", "in_app"];

    await step.sendEvent("forward-notification-compat-event", {
      name: "notification/send",
      data: {
        user_id: event.data.user_id ?? event.data.recipients?.[0] ?? "",
        event_type: event.data.event_type,
        channels: channels.map((item) => (item === "both" ? "in_app" : item)).filter((item) => item === "email" || item === "in_app"),
        payload: (event.data.payload ?? {}) as Record<string, unknown>,
      },
    });

    return { forwarded: true };
  },
);
