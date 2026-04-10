import { dbQuery } from "../../../lib/db/client";
import { AlgorandService } from "../../services/algorand";
import { inngest } from "../client";
import { createInAppNotification } from "../shared";

interface ExpiredBountyCandidate {
  id: string;
  deadline: Date;
  grace_period_minutes: number;
  creator_id: string;
  status: string;
  adjusted_deadline: Date;
  has_submissions: boolean;
  has_non_failed: boolean;
}

const algorandService = new AlgorandService();

function hourBucket(now = new Date()) {
  return now.toISOString().slice(0, 13).replace(/[-:T]/g, "");
}

export const deadlineRefundJob = inngest.createFunction(
  {
    id: "deadline-refund",
    name: "Deadline-Based Refund Engine",
    retries: 3,
  },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const expired = await step.run("find-expired-bounties", async () => {
      const rows = await dbQuery<ExpiredBountyCandidate>(
        `
          WITH downtime AS (
            SELECT bounty_id,
                   SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at)))::bigint AS downtime_seconds
            FROM platform_downtime
            GROUP BY bounty_id
          )
          SELECT b.id,
                 b.deadline,
                 b.grace_period_minutes,
                 b.creator_id,
                 b.status,
                 (b.deadline + make_interval(secs => COALESCE(d.downtime_seconds, 0))) AS adjusted_deadline,
                 EXISTS (SELECT 1 FROM submissions s WHERE s.bounty_id = b.id) AS has_submissions,
                 EXISTS (
                   SELECT 1
                   FROM submissions s
                   WHERE s.bounty_id = b.id
                     AND s.status <> 'failed'
                 ) AS has_non_failed
          FROM bounties b
          LEFT JOIN downtime d ON d.bounty_id = b.id
          WHERE b.deadline < NOW()
            AND b.status IN ('open', 'in_progress', 'accepted')
            AND b.deleted_at IS NULL
        `,
      );

      return rows.rows
        .filter((row) => row.adjusted_deadline.getTime() < Date.now())
        .map((row) => {
          const reason = !row.has_submissions
            ? ("no_submission" as const)
            : !row.has_non_failed
              ? ("all_failed" as const)
              : ("grace_elapsed" as const);

          return {
            id: row.id,
            reason,
          };
        });
    });

    await step.sendEvent(
      "fan-out-refunds",
      expired.map((bounty) => ({
        id: `refund-${bounty.id}-${hourBucket()}`,
        name: "bounty/expired" as const,
        data: {
          bounty_id: bounty.id,
          reason: bounty.reason,
        },
      })),
    );

    return {
      count: expired.length,
    };
  },
);

export const singleBountyRefundJob = inngest.createFunction(
  {
    id: "single-bounty-refund",
    name: "Single Bounty Refund",
    retries: 3,
    concurrency: { key: "event.data.bounty_id", limit: 1 },
  },
  { event: "bounty/expired" },
  async ({ event, step }) => {
    const bounty = await step.run("load-bounty-for-refund", async () => {
      const rows = await dbQuery<{
        id: string;
        creator_id: string;
        deadline: Date;
        grace_period_minutes: number;
        status: string;
      }>(
        `
          SELECT id, creator_id, deadline, grace_period_minutes, status
          FROM bounties
          WHERE id = $1
          LIMIT 1
        `,
        [event.data.bounty_id],
      );

      if ((rows.rowCount ?? 0) === 0) {
        throw new Error("DL-404: bounty not found");
      }

      return rows.rows[0];
    });

    const nearDeadlineSubmission = await step.run("detect-near-deadline-race", async () => {
      const rows = await dbQuery<{ id: string }>(
        `
          SELECT id
          FROM submissions
          WHERE bounty_id = $1
            AND submission_received_at >= $2 - INTERVAL '60 seconds'
            AND submission_received_at <= $2 + INTERVAL '60 seconds'
          LIMIT 1
        `,
        [event.data.bounty_id, bounty.deadline],
      );

      return (rows.rowCount ?? 0) > 0;
    });

    if (nearDeadlineSubmission) {
      await step.sleep("hold-before-refund", "2m");

      const appeared = await step.run("recheck-near-deadline-race", async () => {
        const rows = await dbQuery<{ id: string; status: string }>(
          `
            SELECT id, status
            FROM submissions
            WHERE bounty_id = $1
              AND submission_received_at >= $2 - INTERVAL '60 seconds'
              AND submission_received_at <= $2 + INTERVAL '60 seconds'
            LIMIT 1
          `,
          [event.data.bounty_id, bounty.deadline],
        );

        return rows.rows[0] ?? null;
      });

      if (appeared && ["submitted", "validating", "awaiting_ci"].includes(appeared.status)) {
        return {
          skipped: true,
          reason: "deadline_race_submission_detected",
        };
      }
    }

    if (event.data.reason === "grace_elapsed") {
      const bountyDeadlineMs = new Date(bounty.deadline).getTime();
      const graceEndsAt = new Date(bountyDeadlineMs + bounty.grace_period_minutes * 60_000);
      if (Date.now() < graceEndsAt.getTime()) {
        return {
          skipped: true,
          reason: "grace_period_active",
        };
      }
    }

    const refund = await step.run("execute-escrow-refund", async () => {
      return algorandService.refundClientEscrowWithRetry({ bountyId: bounty.id });
    });

    await step.run("persist-refund-state", async () => {
      if (event.data.reason === "no_submission") {
        await dbQuery(
          "UPDATE bounties SET status = 'expired_no_submission', updated_at = NOW() WHERE id = $1",
          [bounty.id],
        );
      } else if (event.data.reason === "all_failed") {
        await dbQuery(
          "UPDATE bounties SET status = 'expired_all_failed', updated_at = NOW() WHERE id = $1",
          [bounty.id],
        );
      } else {
        await dbQuery(
          "UPDATE bounties SET status = 'expired', updated_at = NOW() WHERE id = $1",
          [bounty.id],
        );
      }

      if (event.data.reason === "grace_elapsed") {
        await dbQuery(
          `
            UPDATE submissions
            SET status = 'abandoned', updated_at = NOW()
            WHERE bounty_id = $1
              AND status IN ('in_progress', 'submitted')
          `,
          [bounty.id],
        );

        await dbQuery(
          `
            UPDATE users
            SET reputation_score = GREATEST(0, reputation_score - 3),
                updated_at = NOW()
            WHERE id IN (
              SELECT freelancer_id
              FROM submissions
              WHERE bounty_id = $1
            )
          `,
          [bounty.id],
        );
      }
    });

    await step.sendEvent("notify-client-refund", {
      name: "notification/send",
      data: {
        user_id: bounty.creator_id,
        event_type: "bounty_refund_completed",
        channels: ["in_app"],
        payload: {
          bounty_id: bounty.id,
          reason: event.data.reason,
          refund_tx_id: refund.txId,
        },
      },
    });

    await createInAppNotification(bounty.creator_id, "bounty_refund_completed", {
      bounty_id: bounty.id,
      reason: event.data.reason,
      refund_tx_id: refund.txId,
    });

    return {
      refunded: true,
      tx_id: refund.txId,
    };
  },
);
