import { dbQuery } from "../../lib/db/client";
import { inngest } from "./aiScoring.job";
import { processPayoutRelease } from "../services/payout.service";

interface PayoutReleaseEvent {
  data: {
    submission_id: string;
    bounty_id: string;
    final_score: number;
  };
}

export const payoutReleaseJob = inngest.createFunction(
  {
    id: "payout_release",
    retries: 3,
    name: "Payout Release Job",
  },
  { event: "payout_release/requested" },
  async (context) => {
    const event = context.event as PayoutReleaseEvent;
    const attempt = (context as unknown as { attempt?: number }).attempt ?? 1;

    try {
      const result = await context.step.run("run_payout_release", async () => {
        return processPayoutRelease(
          event.data,
          {
            send: async (eventName, data) => {
              await inngest.send({ name: eventName, data });
            },
          },
          {
            emitToUser: async (userId, eventName, payload) => {
              await dbQuery(
                `
                  INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
                  VALUES ($1, 'in_app', $2, $3::jsonb, FALSE, 0)
                `,
                [userId, eventName, JSON.stringify(payload)],
              );
            },
          },
        );
      });

      return {
        ok: true,
        attempt,
        result,
      };
    } catch (error) {
      if (attempt >= 3) {
        await context.step.run("dead_letter_payout_release", async () => {
          await dbQuery(
            `
              UPDATE payouts
              SET status = CASE WHEN status = 'pending' THEN 'failed' ELSE status END,
                  retry_count = retry_count + 1,
                  updated_at = NOW()
              WHERE submission_id = $1
            `,
            [event.data.submission_id],
          );

          await dbQuery(
            `
              INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
              SELECT b.creator_id, 'in_app', 'payout_release_dead_letter', $2::jsonb, FALSE, 0
              FROM bounties b
              WHERE b.id = $1
            `,
            [
              event.data.bounty_id,
              JSON.stringify({
                submission_id: event.data.submission_id,
                code: "SC-C-002",
                detail: error instanceof Error ? error.message : "Unknown payout release failure",
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
