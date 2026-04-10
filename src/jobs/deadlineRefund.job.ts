import { inngest } from "./aiScoring.job";
import { processDeadlineRefundCycle } from "../services/payout.service";

export const deadlineRefundJob = inngest.createFunction(
  {
    id: "deadline_refund",
    name: "Deadline Refund Job",
    retries: 2,
  },
  { cron: "0 * * * *" },
  async (context) => {
    const result = await context.step.run("run_deadline_refund_cycle", async () => {
      return processDeadlineRefundCycle({
        send: async (eventName, data) => {
          await inngest.send({ name: eventName, data });
        },
      });
    });

    return {
      ok: true,
      ...result,
    };
  },
);
