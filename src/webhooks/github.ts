import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import { dbQuery } from "../../lib/db/client";
import { inngest } from "../jobs/aiScoring.job";
import { queueCiValidationFromWorkflowWebhook } from "../services/validation.service";

const router = Router();

router.post("/github", express.raw({ type: "application/json", limit: "2mb" }), async (request, response) => {
  const deliveryId = String(request.headers["x-github-delivery"] ?? "").trim();
  const eventType = String(request.headers["x-github-event"] ?? "").trim();
  const signature = String(request.headers["x-hub-signature-256"] ?? "").trim();

  if (!deliveryId || !eventType) {
    return response.status(400).json({
      error: "Bad request",
      code: 400,
      detail: "GH-W-400: Missing required GitHub delivery headers",
    });
  }

  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return response.status(500).json({
      error: "Webhook unavailable",
      code: 500,
      detail: "GH-W-001: GITHUB_WEBHOOK_SECRET is not configured",
    });
  }

  const rawBody = request.body as Buffer;
  if (!Buffer.isBuffer(rawBody)) {
    return response.status(400).json({
      error: "Bad request",
      code: 400,
      detail: "GH-W-401: Webhook payload must be raw bytes",
    });
  }

  if (!verifySignature(rawBody, signature, secret)) {
    return response.status(401).json({
      error: "Unauthorized",
      code: 401,
      detail: "GH-W-002: Invalid webhook signature",
    });
  }

  const payloadHash = createHash("sha256").update(rawBody).digest("hex");
  const payloadText = rawBody.toString("utf8");
  const action = extractWebhookAction(payloadText);

  const deliveryInsert = await dbQuery(
    `
      INSERT INTO github_webhook_deliveries (delivery_id, event_type, action, status, payload_sha256)
      VALUES ($1, $2, $3, 'processing', $4)
      ON CONFLICT (delivery_id) DO NOTHING
      RETURNING id
    `,
    [deliveryId, eventType, action, payloadHash],
  );

  if (deliveryInsert.rowCount === 0) {
    return response.status(202).json({
      accepted: true,
      duplicate: true,
      detail: "GH-W-003: Delivery already processed",
    });
  }

  try {
    const payload = JSON.parse(payloadText) as Record<string, unknown>;
    const outcome = await handleGitHubEvent(eventType, payload, deliveryId);

    await dbQuery(
      `
        UPDATE github_webhook_deliveries
        SET status = $1,
            processed_at = NOW(),
            updated_at = NOW()
        WHERE delivery_id = $2
      `,
      [outcome.status, deliveryId],
    );

    return response.status(202).json({
      accepted: true,
      delivery_id: deliveryId,
      status: outcome.status,
      detail: outcome.detail,
    });
  } catch (error) {
    await dbQuery(
      `
        UPDATE github_webhook_deliveries
        SET status = 'failed',
            processed_at = NOW(),
            updated_at = NOW()
        WHERE delivery_id = $1
      `,
      [deliveryId],
    );

    return response.status(500).json({
      error: "Webhook processing failed",
      code: 500,
      detail: error instanceof Error ? error.message : "GH-W-500: Unknown webhook processing failure",
    });
  }
});

function verifySignature(rawBody: Buffer, signature: string, secret: string) {
  if (!signature.startsWith("sha256=")) {
    return false;
  }

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(signatureBuffer, expectedBuffer);
}

function extractWebhookAction(payloadText: string) {
  try {
    const parsed = JSON.parse(payloadText) as { action?: string };
    return parsed.action ?? null;
  } catch {
    return null;
  }
}

async function handleGitHubEvent(
  eventType: string,
  payload: Record<string, unknown>,
  deliveryId: string,
): Promise<{ status: "processed" | "ignored"; detail: string }> {
  if (eventType !== "workflow_run") {
    return { status: "ignored", detail: "Event type is not handled" };
  }

  const queued = await queueCiValidationFromWorkflowWebhook(
    payload as {
      repository?: { id?: number };
      workflow_run?: {
        id?: number;
        status?: string;
        conclusion?: string | null;
        head_branch?: string | null;
        head_sha?: string | null;
      };
    },
    {
      send: async (eventName, data) => {
        await inngest.send({ name: eventName as never, data: data as never });
      },
    },
    deliveryId,
  );

  if (!queued.queued) {
    return {
      status: "ignored",
      detail: `Workflow delivery ignored: ${queued.reason}`,
    };
  }

  return {
    status: "processed",
    detail: `Queued CI validation for submission ${queued.submission_id}`,
  };
}

export default router;
