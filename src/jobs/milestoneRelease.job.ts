import { dbQuery } from "../../lib/db/client";
import { inngest } from "./aiScoring.job";
import { processMilestoneRelease } from "../services/payout.service";

interface MilestoneReleaseEvent {
  data: {
    milestone_id: string;
    submission_id: string;
    approved_by_client?: boolean;
  };
}

export const milestoneReleaseJob = inngest.createFunction(
  {
    id: "milestone_release",
    retries: 3,
    name: "Milestone Release Job",
  },
  { event: "milestone_release/requested" },
  async (context) => {
    const event = context.event as MilestoneReleaseEvent;
    const attempt = (context as unknown as { attempt?: number }).attempt ?? 1;

    try {
      const result = await context.step.run("run_milestone_release", async () => {
        return processMilestoneRelease(event.data, {
          send: async (eventName, data) => {
            await inngest.send({ name: eventName, data });
          },
        });
      });

      return {
        ok: true,
        attempt,
        result,
      };
    } catch (error) {
      await context.step.run("set_milestone_failed", async () => {
        await dbQuery(
          `
            UPDATE milestones
            SET status = 'failed',
                updated_at = NOW()
            WHERE id = $1
          `,
          [event.data.milestone_id],
        );
      });

      if (attempt >= 3) {
        await context.step.run("notify_milestone_failure", async () => {
          await dbQuery(
            `
              INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
              SELECT b.creator_id, 'in_app', 'milestone_release_failed', $2::jsonb, FALSE, 0
              FROM milestones m
              JOIN bounties b ON b.id = m.bounty_id
              WHERE m.id = $1
            `,
            [
              event.data.milestone_id,
              JSON.stringify({
                code: "SC-C-008",
                submission_id: event.data.submission_id,
                detail: error instanceof Error ? error.message : "Unknown milestone payout failure",
              }),
            ],
          );
        });

        return {
          ok: false,
          dead_lettered: true,
          detail: error instanceof Error ? error.message : "Unknown error",
        };
      }

      throw error;
    }
  },
);
