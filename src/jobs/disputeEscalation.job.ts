import { dbQuery } from "../../lib/db/client";
import { runDisputeEscalationCycle } from "../services/dispute.service";
import { inngest } from "./aiScoring.job";

export const disputeEscalationJob = inngest.createFunction(
  {
    id: "dispute_escalation",
    name: "Dispute Escalation Job",
    retries: 1,
  },
  { cron: "0 */6 * * *" },
  async (context) => {
    const result = await context.step.run("escalate_stale_disputes", async () => {
      return runDisputeEscalationCycle(
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
      ...result,
    };
  },
);
