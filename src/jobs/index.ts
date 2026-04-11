import { serve } from "inngest/express";
import { aiScoringJob, inngest } from "./aiScoring.job";
import { ciValidationJob } from "./ciValidation.job";
import { payoutReleaseJob } from "./payoutRelease.job";
import { deadlineRefundJob } from "./deadlineRefund.job";
import { milestoneReleaseJob } from "./milestoneRelease.job";
import { disputeEscalationJob } from "./disputeEscalation.job";
import { disputeResolutionJob } from "./disputeResolution.job";
import { sendNotificationCompatJob, sendNotificationJob } from "./sendNotification.job";
import { consistencyCheckJob } from "./consistencyCheck.job";
import { sanctionsSyncJob } from "./sanctionsSync.job";
import { hackathonReviewJob } from "./hackathonReview.job";
import { deniDemoJob } from "./deniDemo.job";

export const inngestApp = serve({
  client: inngest,
  functions: [
    aiScoringJob,
    ciValidationJob,
    payoutReleaseJob,
    deadlineRefundJob,
    milestoneReleaseJob,
    disputeEscalationJob,
    disputeResolutionJob,
    consistencyCheckJob,
    sanctionsSyncJob,
    hackathonReviewJob,
    deniDemoJob,
    sendNotificationJob,
    sendNotificationCompatJob,
  ],
});
