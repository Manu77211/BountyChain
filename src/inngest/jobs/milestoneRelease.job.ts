import { processMilestoneRelease } from "../../services/payout.service";
import { inngest } from "../client";

export const milestoneReleaseJob = inngest.createFunction(
  {
    id: "milestone-release",
    name: "Milestone Release Engine",
    retries: 3,
    concurrency: { key: "event.data.milestone_id", limit: 1 },
    timeouts: { finish: "20m" },
  },
  { event: "milestone/unlock_requested" },
  async ({ event, step }) => {
    const result = await step.run("execute-milestone-release", async () => {
      return processMilestoneRelease(
        {
          milestone_id: event.data.milestone_id,
          submission_id: event.data.submission_id,
          approved_by_client: true,
        },
        {
          send: async (name, data) => {
            await step.sendEvent("forward-milestone-service-event", {
              name: name as never,
              data: data as never,
            });
          },
        },
      );
    });

    if (result.state === "paid") {
      await step.sendEvent("emit-milestone-paid", {
        name: "milestone/paid",
        data: {
          milestone_id: event.data.milestone_id,
          tx_id: result.tx_id,
        },
      });
      return result;
    }

    await step.sendEvent("emit-milestone-failed", {
      name: "milestone/failed",
      data: {
        milestone_id: event.data.milestone_id,
        reason: "SC-C-008",
      },
    });

    return result;
  },
);
