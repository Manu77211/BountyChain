import { dbQuery } from "../../lib/db/client";
import { inngest } from "./aiScoring.job";
import { processCiValidationJob } from "../services/validation.service";

interface CiValidationRequestedEvent {
  data: {
    submission_id: string;
    delivery_id?: string;
  };
}

export const ciValidationJob = inngest.createFunction(
  {
    id: "ci_validation",
    retries: 2,
    name: "CI Validation Job",
  },
  { event: "ci_validation/requested" },
  async (context) => {
    const event = context.event as CiValidationRequestedEvent;
    const attempt = (context as unknown as { attempt?: number }).attempt ?? 1;

    try {
      const result = await context.step.run("validate_ci_status", async () => {
        return processCiValidationJob(event.data, {
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
      if (attempt >= 2) {
        await context.step.run("mark_ci_validation_dead_letter", async () => {
          await dbQuery(
            `
              UPDATE submissions
              SET ci_status = CASE WHEN ci_status IN ('pending', 'running') THEN 'timeout' ELSE ci_status END,
                  status = CASE WHEN status = 'awaiting_ci' THEN 'failed' ELSE status END,
                  updated_at = NOW()
              WHERE id = $1
            `,
            [event.data.submission_id],
          );

          const recipients = await dbQuery<{ freelancer_id: string; creator_id: string }>(
            `
              SELECT s.freelancer_id, b.creator_id
              FROM submissions s
              JOIN bounties b ON b.id = s.bounty_id
              WHERE s.id = $1
              LIMIT 1
            `,
            [event.data.submission_id],
          );

          if (recipients.rowCount === 0) {
            return;
          }

          const detail = error instanceof Error ? error.message : "Unknown CI validation failure";
          const targets = [recipients.rows[0].freelancer_id, recipients.rows[0].creator_id];

          for (const userId of targets) {
            await dbQuery(
              `
                INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
                VALUES ($1, 'in_app', 'ci_validation_dead_letter', $2::jsonb, FALSE, 0)
              `,
              [
                userId,
                JSON.stringify({
                  submission_id: event.data.submission_id,
                  code: "CI-V-500",
                  detail,
                }),
              ],
            );
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
