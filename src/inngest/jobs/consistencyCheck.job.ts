import { dbQuery } from "../../../lib/db/client";
import { runDisputeEscalationCycle } from "../../services/dispute.service";
import { inngest } from "../client";
import { createInAppNotification } from "../shared";

let coldStartFailures = 0;

async function queryWithTimeout<T>(promise: Promise<T>, ms: number) {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("DB timeout")), ms);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export const consistencyCheckJob = inngest.createFunction(
  {
    id: "consistency-check",
    name: "System Consistency Check",
    retries: 2,
  },
  { cron: "*/30 * * * *" },
  async ({ step }) => {
    const initialProbe = await step.run("probe-db-cold-start", async () => {
      try {
        await queryWithTimeout(dbQuery("SELECT 1"), 10_000);
        coldStartFailures = 0;
        return { ok: true };
      } catch (error) {
        coldStartFailures += 1;

        if (coldStartFailures >= 3) {
          const admins = await dbQuery<{ id: string }>(
            "SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL",
          );
          for (const admin of admins.rows) {
            await createInAppNotification(admin.id, "consistency_check_db_failure", {
              detail: error instanceof Error ? error.message : "DB cold start failures",
              consecutive_failures: coldStartFailures,
            });
          }
        }

        return { ok: false, detail: error instanceof Error ? error.message : "DB cold start failure" };
      }
    });

    if (!initialProbe.ok) {
      return {
        skipped: true,
        reason: "neon_cold_start",
      };
    }

    const escrow = await step.run("check-escrow-integrity", async () => {
      const rows = await dbQuery<{ id: string }>(
        `
          SELECT id
          FROM bounties
          WHERE escrow_locked = TRUE
            AND escrow_contract_address IS NULL
            AND deleted_at IS NULL
            AND status <> 'error_escrow_corrupt'
        `,
      );

      for (const row of rows.rows) {
        await dbQuery(
          "UPDATE bounties SET status = 'error_escrow_corrupt', updated_at = NOW() WHERE id = $1",
          [row.id],
        );
      }

      return rows.rows.map((item) => item.id);
    });

    const orphaned = await step.run("check-orphaned-payouts", async () => {
      const rows = await dbQuery<{ id: string; submission_id: string; bounty_id: string }>(
        `
          SELECT p.id, p.submission_id, s.bounty_id
          FROM payouts p
          JOIN submissions s ON s.id = p.submission_id
          WHERE p.status = 'processing'
            AND p.updated_at < NOW() - INTERVAL '1 hour'
        `,
      );

      for (const payout of rows.rows) {
        await dbQuery(
          "UPDATE payouts SET status = 'failed', retry_count = retry_count + 1, updated_at = NOW() WHERE id = $1",
          [payout.id],
        );
      }

      return rows.rows;
    });

    const stuckSubmissions = await step.run("check-stuck-submissions", async () => {
      const rows = await dbQuery<{ id: string; bounty_id: string; ci_status: string; scoring_mode: "ai_only" | "ci_only" | "hybrid" }>(
        `
          SELECT s.id,
                 s.bounty_id,
                 s.ci_status,
                 b.scoring_mode
          FROM submissions s
          JOIN bounties b ON b.id = s.bounty_id
          WHERE s.status = 'validating'
            AND s.updated_at < NOW() - INTERVAL '2 hours'
        `,
      );

      return rows.rows;
    });

    for (const submission of stuckSubmissions) {
      if (submission.ci_status === "passed") {
        await step.sendEvent(`requeue-ai-${submission.id}`, {
          name: "submission/scoring_requested",
          data: {
            submission_id: submission.id,
            bounty_id: submission.bounty_id,
            scoring_mode: submission.scoring_mode,
            cached_diff: "",
          },
        });
      } else {
        await step.sendEvent(`requeue-ci-${submission.id}`, {
          name: "submission/ci_completed",
          data: {
            submission_id: submission.id,
            ci_status: "timeout",
            skipped_count: 0,
            total_count: 0,
            run_id: `consistency-${submission.id}`,
          },
        });
      }
    }

    const disputeSummary = await step.run("check-dispute-sla", async () => {
      return runDisputeEscalationCycle(
        {
          send: async (name, data) => {
            await step.sendEvent("forward-dispute-sla-event", {
              name: name as never,
              data: data as never,
            });
          },
        },
        {
          emitToUsers: async (userIds, eventType, payload) => {
            for (const userId of [...new Set(userIds)]) {
              await createInAppNotification(userId, eventType, payload);
            }
          },
        },
      );
    });

    const abandoned = await step.run("abandoned-submission-reminders", async () => {
      const rows = await dbQuery<{ id: string; freelancer_id: string; bounty_id: string; creator_id: string }>(
        `
          SELECT s.id, s.freelancer_id, s.bounty_id, b.creator_id
          FROM submissions s
          JOIN bounties b ON b.id = s.bounty_id
          WHERE s.status = 'in_progress'
            AND b.deadline < NOW()
        `,
      );

      for (const row of rows.rows) {
        await dbQuery("UPDATE submissions SET status = 'abandoned', updated_at = NOW() WHERE id = $1", [row.id]);
        await dbQuery(
          "UPDATE users SET reputation_score = GREATEST(0, reputation_score - 3), updated_at = NOW() WHERE id = $1",
          [row.freelancer_id],
        );

        await createInAppNotification(row.freelancer_id, "submission_abandoned", {
          submission_id: row.id,
          bounty_id: row.bounty_id,
          code: "DL-F-002",
        });

        await createInAppNotification(row.creator_id, "submission_abandoned", {
          submission_id: row.id,
          bounty_id: row.bounty_id,
          code: "DL-F-002",
        });
      }

      return rows.rows.length;
    });

    return {
      escrow_corrupt_count: escrow.length,
      orphaned_payout_count: orphaned.length,
      stuck_submission_count: stuckSubmissions.length,
      dispute_escalated_count: disputeSummary.processed_count,
      abandoned_count: abandoned,
    };
  },
);
