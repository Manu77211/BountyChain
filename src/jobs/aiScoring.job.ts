import { Inngest } from "inngest";
import type { CiStatus, ScoringMode } from "../../lib/db/types";
import { dbQuery } from "../../lib/db/client";
import { processAiScoringJob } from "../services/aiScoring.service";

export const inngest = new Inngest({ id: "bountyescrow-api" });

interface AiScoringRequestedEvent {
  data: {
    submission_id: string;
    bounty_id: string;
    cached_diff: string;
    ci_status: CiStatus;
    scoring_mode: ScoringMode;
    event_hash?: string;
    retry_count?: number;
  };
}

export const aiScoringJob = inngest.createFunction(
  {
    id: "ai_scoring",
    retries: 3,
    name: "AI Scoring Job",
  },
  { event: "ai_scoring/requested" },
  async (context) => {
    const event = context.event as AiScoringRequestedEvent;
    const attempt = (context as unknown as { attempt?: number }).attempt ?? 1;

    try {
      const result = await context.step.run("process_ai_scoring", async () => {
        return processAiScoringJob(event.data, {
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
      if (attempt >= 3) {
        await context.step.run("dead_letter_after_retries", async () => {
          await dbQuery(
            "UPDATE submissions SET ai_scoring_status = 'manual_review', ai_scoring_in_progress = FALSE WHERE id = $1",
            [event.data.submission_id],
          );

          const related = await dbQuery<{ freelancer_id: string; bounty_id: string }>(
            "SELECT freelancer_id, bounty_id FROM submissions WHERE id = $1 LIMIT 1",
            [event.data.submission_id],
          );

          if (related.rowCount === 0) {
            return;
          }

          const bounty = await dbQuery<{ creator_id: string }>(
            "SELECT creator_id FROM bounties WHERE id = $1 LIMIT 1",
            [related.rows[0].bounty_id],
          );

          const detail = error instanceof Error ? error.message : "Unknown AI scoring failure";
          const recipients = [related.rows[0].freelancer_id, bounty.rows[0]?.creator_id].filter(Boolean);
          for (const userId of recipients) {
            await dbQuery(
              "INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts) VALUES ($1, 'in_app', 'ai_scoring_dead_letter', $2::jsonb, FALSE, 0)",
              [
                userId,
                JSON.stringify({
                  submission_id: event.data.submission_id,
                  code: "AI-F-001",
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
