import { Router, type Request, type Response, type NextFunction } from "express";
import { serve } from "inngest/express";
import { inngest } from "./client";
import { aiScoringJob } from "./jobs/aiScoring.job";
import {
  aiScoringCompatJob,
  ciValidationCompatJob,
  disputeResolutionCompatJob,
  milestoneReleaseCompatJob,
  payoutReleaseCompatJob,
  sendNotificationCompatJob,
} from "./jobs/compatibility.job";
import { consistencyCheckJob } from "./jobs/consistencyCheck.job";
import { ciValidationJob } from "./jobs/ciValidation.job";
import { deadlineRefundJob, singleBountyRefundJob } from "./jobs/deadlineRefund.job";
import { disputeEscalationJob, disputeResolutionJob } from "./jobs/disputeResolution.job";
import { milestoneReleaseJob } from "./jobs/milestoneRelease.job";
import { notificationJob } from "./jobs/notifications.job";
import { payoutReleaseJob } from "./jobs/payoutRelease.job";
import { sanctionsSyncJob, sanctionsSyncOnDemandJob } from "./jobs/sanctionsSync.job";

function verifyInngestSigningConfiguration(request: Request, response: Response, next: NextFunction) {
  const signingKey = process.env.INNGEST_SIGNING_KEY;
  if (!signingKey) {
    response.status(503).json({
      error: "Inngest unavailable",
      code: 503,
      detail: "INNGEST_SIGNING_KEY is not configured",
    });
    return;
  }

  if (request.method === "POST" && process.env.NODE_ENV === "production") {
    const signature = request.header("x-inngest-signature");
    if (!signature) {
      response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "Missing x-inngest-signature header",
      });
      return;
    }
  }

  next();
}

const inngestHandler = serve({
  client: inngest,
  functions: [
    ciValidationJob,
    aiScoringJob,
    payoutReleaseJob,
    milestoneReleaseJob,
    deadlineRefundJob,
    singleBountyRefundJob,
    disputeResolutionJob,
    disputeEscalationJob,
    notificationJob,
    consistencyCheckJob,
    sanctionsSyncJob,
    sanctionsSyncOnDemandJob,
    ciValidationCompatJob,
    aiScoringCompatJob,
    payoutReleaseCompatJob,
    milestoneReleaseCompatJob,
    disputeResolutionCompatJob,
    sendNotificationCompatJob,
  ],
  signingKey: process.env.INNGEST_SIGNING_KEY,
});

export const inngestApp = Router();
inngestApp.use(verifyInngestSigningConfiguration);
inngestApp.use(inngestHandler);
