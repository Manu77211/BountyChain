import { Router } from "express";
import { z } from "zod";
import { dbQuery } from "../../lib/db/client";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { emitToBounty } from "../realtime/socket";
import { validateBody, validateParams, validateQuery } from "../middleware/validate";

const router = Router();

const idSchema = z.object({
  id: z.string().uuid(),
});

const flagScoreSchema = z.object({
  reason: z.string().trim().min(20),
});

const rateSchema = z.object({
  rating: z.coerce.number().min(0).max(100),
});

const requestChangesSchema = z.object({
  feedback: z.string().trim().min(5).max(2000),
});

const submissionsListQuerySchema = z.object({
  query: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

router.get("/", requireAuth, validateQuery(submissionsListQuerySchema), async (request, response, next) => {
  try {
    if (!request.user) {
      throw new AppError(401, 401, "Unauthorized");
    }

    const query = request.query as unknown as {
      query?: string;
      limit: number;
    };

    const params: Array<string | number> = [request.user.userId];
    const where = ["(s.freelancer_id = $1 OR b.creator_id = $1)"];

    if (query.query) {
      params.push(`%${query.query.toLowerCase()}%`);
      const placeholder = `$${params.length}`;
      where.push(`(
        LOWER(COALESCE(b.title, '')) LIKE ${placeholder}
        OR LOWER(COALESCE(s.github_pr_url, '')) LIKE ${placeholder}
      )`);
    }

    params.push(query.limit);

    const result = await dbQuery<{
      id: string;
      bounty_id: string;
      bounty_title: string;
      github_pr_url: string;
      final_score: number | null;
      status: string;
      ci_status: string;
      submission_received_at: string;
      deadline: string;
      payout_status: string | null;
      payout_amount: string | null;
      payout_tx_id: string | null;
      dispute_id: string | null;
      dispute_status: string | null;
      created_at: string;
    }>(
      `
        SELECT s.id,
               s.bounty_id,
               b.title AS bounty_title,
               s.github_pr_url,
               s.final_score,
               s.status,
               s.ci_status::text AS ci_status,
               s.submission_received_at::text,
               b.deadline::text AS deadline,
               p.status::text AS payout_status,
               p.actual_amount::text AS payout_amount,
               p.tx_id AS payout_tx_id,
               d.id AS dispute_id,
               d.status::text AS dispute_status,
               s.created_at::text AS created_at
        FROM submissions s
        JOIN bounties b ON b.id = s.bounty_id
        LEFT JOIN LATERAL (
          SELECT status, actual_amount, tx_id
          FROM payouts p
          WHERE p.submission_id = s.id
          ORDER BY p.created_at DESC
          LIMIT 1
        ) p ON TRUE
        LEFT JOIN LATERAL (
          SELECT id, status
          FROM disputes d
          WHERE d.submission_id = s.id
          ORDER BY d.created_at DESC
          LIMIT 1
        ) d ON TRUE
        WHERE ${where.join(" AND ")}
        ORDER BY s.created_at DESC
        LIMIT $${params.length}
      `,
      params,
    );

    return response.status(200).json({
      data: result.rows,
    });
  } catch (error) {
    return next(error);
  }
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

router.post("/:id/rate", requireAuth, validateParams(idSchema), validateBody(rateSchema), async (request, response, next) => {
  try {
    if (!request.user) {
      throw new AppError(401, 401, "Unauthorized");
    }

    const candidate = await dbQuery<{
      id: string;
      freelancer_id: string;
      ai_score: number | null;
      creator_id: string;
    }>(
      `
        SELECT s.id,
               s.freelancer_id,
               s.ai_score,
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
    if (request.user.role !== "admin" && row.creator_id !== request.user.userId) {
      throw new AppError(403, 403, "Only project client can rate this submission");
    }

    const clientRating = Number(request.body.rating);
    const aiScore = row.ai_score ?? clientRating;
    const finalScore = Math.round(aiScore * 0.7 + clientRating * 0.3);
    const decision = finalScore >= 70 ? "APPROVED" : "REJECTED";
    const nextStatus = finalScore >= 70 ? "passed" : "failed";
    const stars = Math.max(1, Math.min(5, Math.round(Math.max(1, clientRating) / 20)));

    await dbQuery(
      `
        UPDATE submissions
        SET client_rating_stars = $2,
            final_score = $3,
            status = $4,
            score_finalized_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
      [request.params.id, stars, finalScore, nextStatus],
    );

    await dbQuery(
      `
        INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
        VALUES ($1, 'in_app', 'submission_rated', $2::jsonb, FALSE, 0)
      `,
      [
        row.freelancer_id,
        JSON.stringify({
          submission_id: request.params.id,
          client_rating: clientRating,
          final_score: finalScore,
          decision,
        }),
      ],
    );

    return response.status(200).json({
      aiScore,
      clientRating,
      finalScore,
      decision,
    });
  } catch (error) {
    return next(error);
  }
});

router.post(
  "/:id/request-changes",
  requireAuth,
  validateParams(idSchema),
  validateBody(requestChangesSchema),
  async (request, response, next) => {
    try {
      if (!request.user) {
        throw new AppError(401, 401, "Unauthorized");
      }

      const candidate = await dbQuery<{
        id: string;
        freelancer_id: string;
        creator_id: string;
      }>(
        `
          SELECT s.id,
                 s.freelancer_id,
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
      if (request.user.role !== "admin" && row.creator_id !== request.user.userId) {
        throw new AppError(403, 403, "Only project client can request changes");
      }

      const feedback = String(request.body.feedback).trim();

      await dbQuery(
        `
          UPDATE submissions
          SET status = 'in_progress',
              updated_at = NOW()
          WHERE id = $1
        `,
        [request.params.id],
      );

      await dbQuery(
        `
          INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
          VALUES ($1, 'in_app', 'submission_changes_requested', $2::jsonb, FALSE, 0)
        `,
        [
          row.freelancer_id,
          JSON.stringify({
            submission_id: request.params.id,
            feedback,
          }),
        ],
      );

      return response.status(200).json({
        requested: true,
        feedback,
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post("/:id/retrigger-ci", requireAuth, validateParams(idSchema), async (request, response, next) => {
  try {
    if (!request.user) {
      throw new AppError(401, 401, "Unauthorized");
    }

    const candidate = await dbQuery<{
      id: string;
      bounty_id: string;
      freelancer_id: string;
      creator_id: string;
      ci_status: string;
      ci_retrigger_count: number;
    }>(
      `
        SELECT s.id,
               s.bounty_id,
               s.freelancer_id,
               b.creator_id,
               s.ci_status::text AS ci_status,
               COALESCE(s.ci_retrigger_count, 0) AS ci_retrigger_count
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
    const isParty =
      request.user.role === "admin" ||
      row.freelancer_id === request.user.userId ||
      row.creator_id === request.user.userId;

    if (!isParty) {
      throw new AppError(403, 403, "Only project participants can re-trigger CI");
    }

    if (row.ci_status !== "timeout") {
      throw new AppError(409, 409, "CI can only be re-triggered from timeout state");
    }

    if (row.ci_retrigger_count >= 1) {
      throw new AppError(409, 409, "GH-F-003: CI re-trigger limit reached");
    }

    await dbQuery(
      `
        UPDATE submissions
        SET ci_retrigger_count = COALESCE(ci_retrigger_count, 0) + 1,
            ci_status = 'pending',
            status = 'awaiting_ci',
            updated_at = NOW()
        WHERE id = $1
      `,
      [request.params.id],
    );

    emitToBounty(row.bounty_id, "bounty:ci_running", {
      bounty_id: row.bounty_id,
      submission_id: row.id,
      ci_status: "pending",
    });

    return response.status(200).json({
      retriggered: true,
      ci_status: "pending",
      attempts_used: row.ci_retrigger_count + 1,
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
