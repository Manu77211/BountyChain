import { serve } from "inngest/express";
import { aiScoringJob, inngest } from "./aiScoring.job";
import { ciValidationJob } from "./ciValidation.job";
import { payoutReleaseJob } from "./payoutRelease.job";
import { deadlineRefundJob } from "./deadlineRefund.job";
import { milestoneReleaseJob } from "./milestoneRelease.job";

export const inngestApp = serve({
  client: inngest,
  functions: [
    aiScoringJob,
    ciValidationJob,
    payoutReleaseJob,
    deadlineRefundJob,
    milestoneReleaseJob,
  ],
});
