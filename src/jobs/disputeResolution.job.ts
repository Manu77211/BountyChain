import { dbQuery } from "../../lib/db/client";
import { resolveDispute } from "../services/dispute.service";
import { inngest } from "./aiScoring.job";

interface DisputeResolutionEvent {
  data: {
    dispute_id: string;
  };
}

export const disputeResolutionJob = inngest.createFunction(
  {
    id: "dispute_resolution",
    name: "Dispute Resolution Job",
    retries: 3,
  },
  { event: "dispute_resolution/requested" },
  async (context) => {
    const event = context.event as DisputeResolutionEvent;
    const attempt = (context as unknown as { attempt?: number }).attempt ?? 1;

    try {
      const result = await context.step.run("resolve_dispute", async () => {
        return resolveDispute(
          { dispute_id: event.data.dispute_id },
          {
            send: async (eventName, data) => {
              await inngest.send({ name: eventName, data });
            },
          },
          {
            emitToUsers: async (userIds, eventName, payload) => {
              for (const userId of [...new Set(userIds)]) {
                await dbQuery(
                  `
                    INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
                    VALUES ($1, 'in_app', $2, $3::jsonb, FALSE, 0)
                  `,
                  [userId, eventName, JSON.stringify(payload)],
                );
              }
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
        await context.step.run("resolution_dead_letter", async () => {
          await dbQuery(
            `
              UPDATE disputes
              SET status = CASE WHEN status = 'under_review' THEN 'escalated' ELSE status END,
                  escalated_at = CASE WHEN escalated_at IS NULL THEN NOW() ELSE escalated_at END,
                  updated_at = NOW()
              WHERE id = $1
            `,
            [event.data.dispute_id],
          );

          const recipients = await dbQuery<{ creator_id: string; freelancer_id: string }>(
            `
              SELECT b.creator_id, s.freelancer_id
              FROM disputes d
              JOIN submissions s ON s.id = d.submission_id
              JOIN bounties b ON b.id = s.bounty_id
              WHERE d.id = $1
              LIMIT 1
            `,
            [event.data.dispute_id],
          );

          if ((recipients.rowCount ?? 0) > 0) {
            for (const recipient of [recipients.rows[0].creator_id, recipients.rows[0].freelancer_id]) {
              await dbQuery(
                `
                  INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
                  VALUES ($1, 'in_app', 'dispute_resolution_dead_letter', $2::jsonb, FALSE, 0)
                `,
                [
                  recipient,
                  JSON.stringify({
                    dispute_id: event.data.dispute_id,
                    code: "RT-002",
                    detail: error instanceof Error ? error.message : "Unknown resolution error",
                  }),
                ],
              );
            }
          }
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
