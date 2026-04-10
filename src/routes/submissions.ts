import { Router } from "express";
import { z } from "zod";
import { dbQuery } from "../../lib/db/client";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { validateBody, validateParams } from "../middleware/validate";

const router = Router();

const idSchema = z.object({
  id: z.string().uuid(),
});

const flagScoreSchema = z.object({
  reason: z.string().trim().min(20),
});

router.get("/:id", requireAuth, validateParams(idSchema), async (request, response, next) => {
  try {
    if (!request.user) {
      throw new AppError(401, 401, "Unauthorized");
    }

    const detail = await dbQuery<{
      submission_id: string;
      bounty_id: string;
      freelancer_id: string;
      submission_status: string;
      ci_status: string;
      ci_run_id: string | null;
      ai_score: number | null;
      ai_score_raw: Record<string, unknown> | null;
      ai_integrity_flag: boolean;
      ai_language_mismatch_flag: boolean;
      final_score: number | null;
      score_finalized_at: Date | null;
      client_flagged_at: Date | null;
      github_pr_url: string;
      head_sha: string | null;
      bounty_title: string;
      bounty_creator_id: string;
      payout_id: string | null;
      payout_status: string | null;
      payout_expected: string | null;
      payout_actual: string | null;
      payout_tx_id: string | null;
      payout_mismatch: boolean | null;
    }>(
      `
        SELECT s.id AS submission_id,
               s.bounty_id,
               s.freelancer_id,
               s.status AS submission_status,
               s.ci_status,
               s.ci_run_id,
               s.ai_score,
               s.ai_score_raw,
               s.ai_integrity_flag,
               s.ai_language_mismatch_flag,
               s.final_score,
               s.score_finalized_at,
               s.client_flagged_at,
               s.github_pr_url,
               s.head_sha,
               b.title AS bounty_title,
               b.creator_id AS bounty_creator_id,
               p.id AS payout_id,
               p.status AS payout_status,
               p.expected_amount AS payout_expected,
               p.actual_amount AS payout_actual,
               p.tx_id AS payout_tx_id,
               p.mismatch_flagged AS payout_mismatch
        FROM submissions s
        JOIN bounties b ON b.id = s.bounty_id
        LEFT JOIN payouts p ON p.submission_id = s.id
        WHERE s.id = $1
        ORDER BY p.created_at DESC
        LIMIT 1
      `,
      [request.params.id],
    );

    if ((detail.rowCount ?? 0) === 0) {
      throw new AppError(404, 404, "Submission not found");
    }

    const row = detail.rows[0];
    const isAllowed =
      request.user.role === "admin" ||
      row.bounty_creator_id === request.user.userId ||
      row.freelancer_id === request.user.userId;

    if (!isAllowed) {
      throw new AppError(403, 403, "Forbidden");
    }

    const disputes = await dbQuery<Record<string, unknown>>(
      `
        SELECT id, status, outcome, dispute_type, raised_at, resolved_at
        FROM disputes
        WHERE submission_id = $1
        ORDER BY created_at DESC
      `,
      [request.params.id],
    );

    return response.status(200).json({
      submission: {
        id: row.submission_id,
        bounty_id: row.bounty_id,
        status: row.submission_status,
        ci_status: row.ci_status,
        ci_run_id: row.ci_run_id,
        github_pr_url: row.github_pr_url,
        head_sha: row.head_sha,
        ai_score: row.ai_score,
        ai_score_raw: row.ai_score_raw,
        ai_integrity_flag: row.ai_integrity_flag,
        ai_language_mismatch_flag: row.ai_language_mismatch_flag,
        final_score: row.final_score,
        score_finalized_at: row.score_finalized_at,
        client_flagged_at: row.client_flagged_at,
      },
      bounty: {
        id: row.bounty_id,
        title: row.bounty_title,
      },
      payout: {
        id: row.payout_id,
        status: row.payout_status,
        expected_amount: row.payout_expected,
        actual_amount: row.payout_actual,
        tx_id: row.payout_tx_id,
        mismatch_flagged: row.payout_mismatch,
      },
      disputes: disputes.rows,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/:id/flag-score", requireAuth, validateParams(idSchema), validateBody(flagScoreSchema), async (request, response, next) => {
  try {
    if (!request.user) {
      throw new AppError(401, 401, "Unauthorized");
    }

    const candidate = await dbQuery<{
      id: string;
      freelancer_id: string;
      bounty_id: string;
      score_finalized_at: Date | null;
      creator_id: string;
    }>(
      `
        SELECT s.id,
               s.freelancer_id,
               s.bounty_id,
               s.score_finalized_at,
               b.creator_id
        FROM submissions s
        JOIN bounties b ON b.id = s.bounty_id
        WHERE s.id = $1
        LIMIT 1
      `,
      [request.params.id],
    );

    if ((candidate.rowCount ?? 0) === 0) {
      throw new AppError(404, 404, "Submission not found");
    }

    const row = candidate.rows[0];
    const isParty = row.creator_id === request.user.userId || row.freelancer_id === request.user.userId;
    if (!isParty) {
      throw new AppError(403, 403, "Only parties can flag score results");
    }

    if (!row.score_finalized_at) {
      throw new AppError(409, 409, "AI-C-001: score is not published yet");
    }

    const windowMs = 48 * 60 * 60 * 1000;
    if (Date.now() - row.score_finalized_at.getTime() > windowMs) {
      throw new AppError(409, 409, "AI-C-001: score flag window (48h) has expired");
    }

    await dbQuery(
      "UPDATE submissions SET client_flagged_at = NOW(), updated_at = NOW() WHERE id = $1",
      [request.params.id],
    );

    await dbQuery(
      `
        INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
        VALUES ($1, 'in_app', 'score_flagged', $2::jsonb, FALSE, 0)
      `,
      [
        row.creator_id,
        JSON.stringify({
          submission_id: row.id,
          reason: request.body.reason,
          code: "AI-C-001",
        }),
      ],
    );

    return response.status(200).json({
      flagged: true,
      detail: "Score flagged for review",
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
