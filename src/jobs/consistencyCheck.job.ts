import { dbQuery } from "../../lib/db/client";
import { inngest } from "./aiScoring.job";
import { AlgorandService } from "../services/algorand";
import { runDisputeEscalationCycle } from "../services/dispute.service";
import { logEvent } from "../utils/logger";

const algorandService = new AlgorandService();

interface StuckSubmissionRow {
  id: string;
  bounty_id: string;
  ci_status: string;
  ai_scoring_status: string;
  ai_scoring_attempts: number;
  ci_retrigger_count: number;
  scoring_mode: "ai_only" | "ci_only" | "hybrid";
}

interface AbandonedSubmissionRow {
  id: string;
  bounty_id: string;
  freelancer_id: string;
  creator_id: string;
  created_at: Date;
  deadline: Date;
}

async function getAdminUserIds() {
  const admins = await dbQuery<{ id: string }>(
    "SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL",
  );
  return admins.rows.map((row) => row.id);
}

async function alertUsers(userIds: string[], eventType: string, payload: Record<string, unknown>) {
  const deduped = [...new Set(userIds.filter(Boolean))];
  for (const userId of deduped) {
    await dbQuery(
      `
        INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
        VALUES ($1, 'in_app', $2, $3::jsonb, FALSE, 0)
      `,
      [userId, eventType, JSON.stringify(payload)],
    );
  }
}

async function checkEscrowIntegrity() {
  const inconsistent = await dbQuery<{ id: string }>(
    `
      SELECT id
      FROM bounties
      WHERE deleted_at IS NULL
        AND escrow_locked = TRUE
        AND escrow_contract_address IS NULL
        AND status <> 'error_escrow_corrupt'
    `,
  );

  if ((inconsistent.rowCount ?? 0) === 0) {
    return { escrow_corrupt_count: 0 };
  }

  for (const bounty of inconsistent.rows) {
    await dbQuery(
      "UPDATE bounties SET status = 'error_escrow_corrupt', updated_at = NOW() WHERE id = $1",
      [bounty.id],
    );
  }

  const adminIds = await getAdminUserIds();
  await alertUsers(adminIds, "escrow_integrity_failed", {
    code: "DB-004",
    bounty_ids: inconsistent.rows.map((row) => row.id),
  });

  return { escrow_corrupt_count: inconsistent.rows.length };
}

async function checkPayoutOrphans() {
  const orphaned = await dbQuery<{
    payout_id: string;
    tx_id: string | null;
    submission_id: string;
    bounty_id: string;
    final_score: number | null;
  }>(
    `
      SELECT p.id AS payout_id,
             p.tx_id,
             p.submission_id,
             s.bounty_id,
             s.final_score
      FROM payouts p
      JOIN submissions s ON s.id = p.submission_id
      JOIN bounties b ON b.id = s.bounty_id
      WHERE p.status = 'processing'
        AND p.updated_at < NOW() - INTERVAL '1 hour'
        AND b.deleted_at IS NULL
    `,
  );

  let completed = 0;
  let failed = 0;

  for (const payout of orphaned.rows) {
    const confirmed = payout.tx_id ? await algorandService.isTransactionConfirmed(payout.tx_id) : false;

    if (confirmed) {
      await dbQuery(
        "UPDATE payouts SET status = 'completed', updated_at = NOW() WHERE id = $1",
        [payout.payout_id],
      );
      completed += 1;
      continue;
    }

    await dbQuery(
      "UPDATE payouts SET status = 'failed', retry_count = retry_count + 1, updated_at = NOW() WHERE id = $1",
      [payout.payout_id],
    );

    await inngest.send({
      name: "payout_release/requested",
      data: {
        submission_id: payout.submission_id,
        bounty_id: payout.bounty_id,
        final_score: payout.final_score ?? 0,
      },
    });

    failed += 1;
  }

  return {
    payout_orphans_checked: orphaned.rows.length,
    payout_completed_count: completed,
    payout_failed_count: failed,
  };
}

async function checkStuckSubmissions() {
  const stuck = await dbQuery<StuckSubmissionRow>(
    `
      SELECT s.id,
             s.bounty_id,
             s.ci_status,
             s.ai_scoring_status,
             s.ai_scoring_attempts,
             s.ci_retrigger_count,
             b.scoring_mode
      FROM submissions s
      JOIN bounties b ON b.id = s.bounty_id
      WHERE s.status = 'validating'
        AND s.updated_at < NOW() - INTERVAL '2 hours'
        AND b.deleted_at IS NULL
    `,
  );

  let ciRequeued = 0;
  let aiRequeued = 0;
  const escalated: string[] = [];

  for (const submission of stuck.rows) {
    const shouldQueueAi =
      submission.ci_status === "passed" ||
      submission.ai_scoring_status === "timeout" ||
      submission.ai_scoring_status === "parse_failed";

    if (shouldQueueAi) {
      await inngest.send({
        name: "ai_scoring/requested",
        data: {
          submission_id: submission.id,
          bounty_id: submission.bounty_id,
          cached_diff: "",
          ci_status: submission.ci_status,
          scoring_mode: submission.scoring_mode,
        },
      });
      aiRequeued += 1;
    } else {
      await dbQuery(
        "UPDATE submissions SET ci_retrigger_count = LEAST(10, ci_retrigger_count + 1), updated_at = NOW() WHERE id = $1",
        [submission.id],
      );

      await inngest.send({
        name: "ci_validation/requested",
        data: { submission_id: submission.id },
      });
      ciRequeued += 1;
    }

    const requeueCount = Math.max(submission.ai_scoring_attempts, submission.ci_retrigger_count);
    if (requeueCount >= 3) {
      escalated.push(submission.id);
    }
  }

  if (escalated.length > 0) {
    const adminIds = await getAdminUserIds();
    await alertUsers(adminIds, "submission_stuck_reenqueue_limit", {
      code: "CI-V-RETRY",
      submission_ids: escalated,
    });
  }

  return {
    stuck_submission_count: stuck.rows.length,
    ci_requeued_count: ciRequeued,
    ai_requeued_count: aiRequeued,
    stuck_submission_escalated_count: escalated.length,
  };
}

async function checkDisputeSla() {
  const result = await runDisputeEscalationCycle(
    {
      send: async (eventName, data) => {
        await inngest.send({ name: eventName, data });
      },
    },
    {
      emitToUsers: async (userIds, eventName, payload) => {
        await alertUsers(userIds, eventName, payload);
      },
    },
  );

  return {
    dispute_escalated_count: result.processed_count,
  };
}

async function hasReminderBeenSent(userId: string, submissionId: string, eventType: string) {
  const existing = await dbQuery<{ id: string }>(
    `
      SELECT id
      FROM notifications
      WHERE user_id = $1
        AND event_type = $2
        AND payload->>'submission_id' = $3
      LIMIT 1
    `,
    [userId, eventType, submissionId],
  );
  return (existing.rowCount ?? 0) > 0;
}

async function checkAbandonedSubmissions() {
  const rows = await dbQuery<AbandonedSubmissionRow>(
    `
      SELECT s.id,
             s.bounty_id,
             s.freelancer_id,
             b.creator_id,
             s.created_at,
             b.deadline
      FROM submissions s
      JOIN bounties b ON b.id = s.bounty_id
      WHERE s.status = 'in_progress'
        AND b.deleted_at IS NULL
    `,
  );

  let remindedHalf = 0;
  let reminded24h = 0;
  let abandoned = 0;

  for (const row of rows.rows) {
    const startMs = row.created_at.getTime();
    const deadlineMs = row.deadline.getTime();
    const nowMs = Date.now();
    const durationMs = Math.max(1, deadlineMs - startMs);
    const elapsedRatio = Math.max(0, Math.min(1, (nowMs - startMs) / durationMs));
    const timeLeftMs = deadlineMs - nowMs;

    if (elapsedRatio >= 0.5) {
      const already = await hasReminderBeenSent(row.freelancer_id, row.id, "submission_50_percent_reminder");
      if (!already) {
        await alertUsers([row.freelancer_id], "submission_50_percent_reminder", {
          code: "DL-F-002",
          submission_id: row.id,
          bounty_id: row.bounty_id,
        });
        remindedHalf += 1;
      }
    }

    if (timeLeftMs > 0 && timeLeftMs <= 24 * 60 * 60 * 1000) {
      const already = await hasReminderBeenSent(row.freelancer_id, row.id, "submission_deadline_24h_reminder");
      if (!already) {
        await alertUsers([row.freelancer_id], "submission_deadline_24h_reminder", {
          code: "DL-F-002",
          submission_id: row.id,
          bounty_id: row.bounty_id,
          deadline: row.deadline.toISOString(),
        });
        reminded24h += 1;
      }
    }

    if (timeLeftMs <= 0) {
      await dbQuery(
        "UPDATE submissions SET status = 'abandoned', updated_at = NOW() WHERE id = $1",
        [row.id],
      );
      await dbQuery(
        "UPDATE users SET reputation_score = GREATEST(0, reputation_score - 3), updated_at = NOW() WHERE id = $1",
        [row.freelancer_id],
      );

      await alertUsers([row.freelancer_id, row.creator_id], "submission_abandoned", {
        code: "DL-F-002",
        submission_id: row.id,
        bounty_id: row.bounty_id,
      });
      abandoned += 1;
    }
  }

  return {
    half_reminder_count: remindedHalf,
    reminder_24h_count: reminded24h,
    abandoned_count: abandoned,
  };
}

export const consistencyCheckJob = inngest.createFunction(
  {
    id: "consistency_check",
    name: "Consistency Check Job",
    retries: 2,
  },
  { cron: "*/30 * * * *" },
  async (context) => {
    const summary = await context.step.run("run_consistency_checks", async () => {
      const escrow = await checkEscrowIntegrity();
      const payouts = await checkPayoutOrphans();
      const stuck = await checkStuckSubmissions();
      const disputeSla = await checkDisputeSla();
      const abandoned = await checkAbandonedSubmissions();

      return {
        ...escrow,
        ...payouts,
        ...stuck,
        ...disputeSla,
        ...abandoned,
      };
    });

    logEvent("info", "Consistency check completed", {
      event_type: "consistency_check_completed",
      ...summary,
    });

    return {
      ok: true,
      summary,
    };
  },
);
