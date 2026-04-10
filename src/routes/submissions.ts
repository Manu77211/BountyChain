import { Router } from "express";
import { z } from "zod";
import { dbQuery } from "../../lib/db/client";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { emitToBounty } from "../realtime/socket";
import { buildSubmissionFeedbackReport } from "../services/submissionFeedback.service";
import { inngest } from "../jobs/aiScoring.job";
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
  comment: z.string().trim().max(2000).optional(),
  rubric: z
    .object({
      completeness: z.coerce.number().min(0).max(100),
      quality: z.coerce.number().min(0).max(100),
      communication: z.coerce.number().min(0).max(100),
      requirementAlignment: z.coerce.number().min(0).max(100),
    })
    .optional(),
});

const requestChangesSchema = z.object({
  feedback: z.string().trim().min(5).max(2000),
});

const submissionsListQuerySchema = z.object({
  query: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const reviewCommentSchema = z.object({
  content: z.string().trim().min(2).max(2000),
  commentType: z
    .enum(["note", "suggestion", "issue", "approve", "reject", "request_changes"])
    .default("note"),
  visibility: z.enum(["both", "client_only", "freelancer_only"]).default("both"),
  parentCommentId: z.string().uuid().optional(),
  revisionId: z.string().uuid().optional(),
});

const reviewDecisionSchema = z.object({
  decision: z.enum(["approve", "request_changes", "reject"]),
  comment: z.string().trim().min(2).max(2000),
});

async function queuePayoutRelease(input: { submissionId: string; bountyId: string; finalScore: number }) {
  await inngest.send({
    name: "payout_release/requested",
    data: {
      submission_id: input.submissionId,
      bounty_id: input.bountyId,
      final_score: input.finalScore,
    },
  });
}

async function maybeQueueAutoRelease(input: {
  submissionId: string;
  bountyId: string;
  finalScore: number | null;
}) {
  if (input.finalScore === null) {
    return false;
  }

  const updated = await dbQuery<{ id: string }>(
    `
      UPDATE submissions
      SET review_gate_status = 'auto_released',
          approved_for_payout_at = NOW(),
          submission_stage = 'final',
          updated_at = NOW()
      WHERE id = $1
        AND review_gate_status = 'awaiting_client_review'
        AND review_window_ends_at IS NOT NULL
        AND review_window_ends_at <= NOW()
      RETURNING id
    `,
    [input.submissionId],
  );

  if ((updated.rowCount ?? 0) === 0) {
    return false;
  }

  await dbQuery(
    `
      UPDATE submissions
      SET status = 'validating',
          updated_at = NOW()
      WHERE id = $1
    `,
    [input.submissionId],
  );

  await queuePayoutRelease({
    submissionId: input.submissionId,
    bountyId: input.bountyId,
    finalScore: input.finalScore,
  });

  return true;
}

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
      submission_stage: string;
      review_gate_status: string;
      review_window_ends_at: Date | null;
      approved_for_payout_at: Date | null;
      ci_status: string;
      ci_run_id: string | null;
      ai_score: number | null;
      ai_score_raw: Record<string, unknown> | null;
      ai_integrity_flag: boolean;
      ai_language_mismatch_flag: boolean;
      final_score: number | null;
      score_finalized_at: Date | null;
      client_flagged_at: Date | null;
      last_client_comment: string | null;
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
           s.submission_stage,
           s.review_gate_status,
           s.review_window_ends_at,
           s.approved_for_payout_at,
               s.ci_status,
               s.ci_run_id,
               s.ai_score,
               s.ai_score_raw,
               s.ai_integrity_flag,
               s.ai_language_mismatch_flag,
               s.final_score,
               s.score_finalized_at,
               s.client_flagged_at,
           s.last_client_comment,
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

    await maybeQueueAutoRelease({
      submissionId: row.submission_id,
      bountyId: row.bounty_id,
      finalScore: row.final_score,
    });

    const revisions = await dbQuery<{
      id: string;
      revision_no: number;
      stage: string;
      artifact_url: string;
      notes: string | null;
      created_at: Date;
    }>(
      `
        SELECT id, revision_no, stage, artifact_url, notes, created_at
        FROM submission_revisions
        WHERE submission_id = $1
        ORDER BY revision_no DESC
      `,
      [request.params.id],
    );

    const comments = await dbQuery<{
      id: string;
      content: string;
      comment_type: string;
      visibility: string;
      parent_comment_id: string | null;
      author_id: string;
      author_name: string;
      created_at: Date;
      is_resolved: boolean;
    }>(
      `
        SELECT c.id,
               c.content,
               c.comment_type,
               c.visibility,
               c.parent_comment_id,
               c.author_id,
               COALESCE(NULLIF(u.display_name, ''), NULLIF(u.email, ''), u.wallet_address) AS author_name,
               c.created_at,
               c.is_resolved
        FROM submission_review_comments c
        JOIN users u ON u.id = c.author_id
        WHERE c.submission_id = $1
        ORDER BY c.created_at ASC
      `,
      [request.params.id],
    );

    const rubrics = await dbQuery<{
      id: string;
      completeness_score: number;
      quality_score: number;
      communication_score: number;
      requirement_alignment_score: number;
      overall_score: number;
      decision: string;
      review_comment: string | null;
      created_at: Date;
    }>(
      `
        SELECT id,
               completeness_score,
               quality_score,
               communication_score,
               requirement_alignment_score,
               overall_score,
               decision,
               review_comment,
               created_at
        FROM submission_review_rubrics
        WHERE submission_id = $1
        ORDER BY created_at DESC
      `,
      [request.params.id],
    );

    const feedbackReports = await dbQuery<{
      id: string;
      implemented_items: unknown;
      missing_items: unknown;
      client_summary: string;
      freelancer_summary: string;
      freelancer_suggestions: unknown;
      client_comment: string | null;
      ai_payload: Record<string, unknown>;
      checklist_payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `
        SELECT id,
               implemented_items,
               missing_items,
               client_summary,
               freelancer_summary,
               freelancer_suggestions,
               client_comment,
               ai_payload,
               checklist_payload,
               created_at
        FROM submission_feedback_reports
        WHERE submission_id = $1
        ORDER BY created_at DESC
      `,
      [request.params.id],
    );

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
        stage: row.submission_stage,
        review_gate_status: row.review_gate_status,
        review_window_ends_at: row.review_window_ends_at,
        approved_for_payout_at: row.approved_for_payout_at,
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
        last_client_comment: row.last_client_comment,
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
      revisions: revisions.rows,
      review_comments: comments.rows,
      review_rubrics: rubrics.rows,
      feedback_reports: feedbackReports.rows,
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
      bounty_id: string;
      freelancer_id: string;
      ai_score: number | null;
      ai_score_raw: Record<string, unknown> | null;
      github_pr_url: string;
      acceptance_criteria: string;
      review_gate_status: string;
      creator_id: string;
    }>(
      `
        SELECT s.id,
               s.bounty_id,
               s.freelancer_id,
               s.ai_score,
               s.ai_score_raw,
               s.github_pr_url,
               s.review_gate_status,
               b.acceptance_criteria,
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
    const nextStatus = finalScore >= 70 ? "submitted" : "failed";
    const stars = Math.max(1, Math.min(5, Math.round(Math.max(1, clientRating) / 20)));
    const rubric = request.body.rubric;
    const comment = typeof request.body.comment === "string" ? request.body.comment.trim() : "";

    const fallbackRubricValue = Math.max(0, Math.min(100, Math.round(clientRating)));
    const completeness = rubric?.completeness ?? fallbackRubricValue;
    const quality = rubric?.quality ?? fallbackRubricValue;
    const communication = rubric?.communication ?? fallbackRubricValue;
    const requirementAlignment = rubric?.requirementAlignment ?? fallbackRubricValue;

    const normalizedDecision = finalScore >= 70 ? "approve" : "request_changes";
    const nextGateStatus = finalScore >= 70 ? "approved" : "changes_requested";

    await dbQuery(
      `
        UPDATE submissions
        SET client_rating_stars = $2,
            final_score = $3,
            status = $4,
            review_gate_status = $5,
            approved_for_payout_at = CASE WHEN $5 = 'approved' THEN NOW() ELSE NULL END,
            approved_for_payout_by = CASE WHEN $5 = 'approved' THEN $6 ELSE NULL END,
            last_client_comment = $7,
            score_finalized_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
      [request.params.id, stars, finalScore, nextStatus, nextGateStatus, request.user.userId, comment || null],
    );

    await dbQuery(
      `
        INSERT INTO submission_review_rubrics (
          submission_id,
          reviewer_id,
          completeness_score,
          quality_score,
          communication_score,
          requirement_alignment_score,
          overall_score,
          decision,
          review_comment
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        request.params.id,
        request.user.userId,
        completeness,
        quality,
        communication,
        requirementAlignment,
        fallbackRubricValue,
        normalizedDecision,
        comment || null,
      ],
    );

    if (comment.length > 0) {
      await dbQuery(
        `
          INSERT INTO submission_review_comments (submission_id, author_id, comment_type, visibility, content)
          VALUES ($1, $2, $3, 'both', $4)
        `,
        [
          request.params.id,
          request.user.userId,
          finalScore >= 70 ? "approve" : "request_changes",
          comment,
        ],
      );
    }

    const feedback = buildSubmissionFeedbackReport({
      acceptanceCriteria: row.acceptance_criteria,
      artifactUrl: row.github_pr_url,
      aiRaw: row.ai_score_raw,
      clientComment: comment || null,
    });

    await dbQuery(
      `
        INSERT INTO submission_feedback_reports (
          submission_id,
          generated_by,
          ai_payload,
          checklist_payload,
          implemented_items,
          missing_items,
          client_summary,
          freelancer_summary,
          freelancer_suggestions,
          client_comment
        )
        VALUES ($1, 'hybrid', $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb, $9)
      `,
      [
        request.params.id,
        JSON.stringify(feedback.aiPayload),
        JSON.stringify(feedback.checklistPayload),
        JSON.stringify(feedback.implementedItems),
        JSON.stringify(feedback.missingItems),
        feedback.clientSummary,
        feedback.freelancerSummary,
        JSON.stringify(feedback.freelancerSuggestions),
        comment || null,
      ],
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

    if (finalScore >= 70) {
      await dbQuery(
        `
          UPDATE submissions
          SET status = 'validating',
              updated_at = NOW()
          WHERE id = $1
        `,
        [request.params.id],
      );

      await queuePayoutRelease({
        submissionId: request.params.id,
        bountyId: row.bounty_id,
        finalScore,
      });
    }

    return response.status(200).json({
      aiScore,
      clientRating,
      finalScore,
      decision,
      gateStatus: nextGateStatus,
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
        bounty_id: string;
        freelancer_id: string;
        github_pr_url: string;
        ai_score_raw: Record<string, unknown> | null;
        acceptance_criteria: string;
        creator_id: string;
      }>(
        `
          SELECT s.id,
                 s.bounty_id,
                 s.freelancer_id,
                 s.github_pr_url,
                 s.ai_score_raw,
                 b.acceptance_criteria,
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
              submission_stage = 'draft',
              review_gate_status = 'changes_requested',
              last_client_comment = $2,
              updated_at = NOW()
          WHERE id = $1
        `,
        [request.params.id, feedback],
      );

      await dbQuery(
        `
          INSERT INTO submission_review_comments (submission_id, author_id, comment_type, visibility, content)
          VALUES ($1, $2, 'request_changes', 'both', $3)
        `,
        [request.params.id, request.user.userId, feedback],
      );

      const feedbackReport = buildSubmissionFeedbackReport({
        acceptanceCriteria: row.acceptance_criteria,
        artifactUrl: row.github_pr_url,
        aiRaw: row.ai_score_raw,
        clientComment: feedback,
      });

      await dbQuery(
        `
          INSERT INTO submission_feedback_reports (
            submission_id,
            generated_by,
            ai_payload,
            checklist_payload,
            implemented_items,
            missing_items,
            client_summary,
            freelancer_summary,
            freelancer_suggestions,
            client_comment
          )
          VALUES ($1, 'hybrid', $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb, $9)
        `,
        [
          request.params.id,
          JSON.stringify(feedbackReport.aiPayload),
          JSON.stringify(feedbackReport.checklistPayload),
          JSON.stringify(feedbackReport.implementedItems),
          JSON.stringify(feedbackReport.missingItems),
          feedbackReport.clientSummary,
          feedbackReport.freelancerSummary,
          JSON.stringify(feedbackReport.freelancerSuggestions),
          feedback,
        ],
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
        gateStatus: "changes_requested",
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.get("/:id/review-comments", requireAuth, validateParams(idSchema), async (request, response, next) => {
  try {
    if (!request.user) {
      throw new AppError(401, 401, "Unauthorized");
    }

    const access = await dbQuery<{ freelancer_id: string; creator_id: string }>(
      `
        SELECT s.freelancer_id, b.creator_id
        FROM submissions s
        JOIN bounties b ON b.id = s.bounty_id
        WHERE s.id = $1
        LIMIT 1
      `,
      [request.params.id],
    );

    if ((access.rowCount ?? 0) === 0) {
      throw new AppError(404, 404, "Submission not found");
    }

    const row = access.rows[0];
    const isParty =
      request.user.role === "admin" ||
      row.creator_id === request.user.userId ||
      row.freelancer_id === request.user.userId;

    if (!isParty) {
      throw new AppError(403, 403, "Forbidden");
    }

    const comments = await dbQuery<{
      id: string;
      content: string;
      comment_type: string;
      visibility: string;
      parent_comment_id: string | null;
      author_id: string;
      author_name: string;
      is_resolved: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        SELECT c.id,
               c.content,
               c.comment_type,
               c.visibility,
               c.parent_comment_id,
               c.author_id,
               COALESCE(NULLIF(u.display_name, ''), NULLIF(u.email, ''), u.wallet_address) AS author_name,
               c.is_resolved,
               c.created_at,
               c.updated_at
        FROM submission_review_comments c
        JOIN users u ON u.id = c.author_id
        WHERE c.submission_id = $1
        ORDER BY c.created_at ASC
      `,
      [request.params.id],
    );

    return response.status(200).json({ data: comments.rows });
  } catch (error) {
    return next(error);
  }
});

router.post(
  "/:id/review-comments",
  requireAuth,
  validateParams(idSchema),
  validateBody(reviewCommentSchema),
  async (request, response, next) => {
    try {
      if (!request.user) {
        throw new AppError(401, 401, "Unauthorized");
      }

      const access = await dbQuery<{ freelancer_id: string; creator_id: string }>(
        `
          SELECT s.freelancer_id, b.creator_id
          FROM submissions s
          JOIN bounties b ON b.id = s.bounty_id
          WHERE s.id = $1
          LIMIT 1
        `,
        [request.params.id],
      );

      if ((access.rowCount ?? 0) === 0) {
        throw new AppError(404, 404, "Submission not found");
      }

      const row = access.rows[0];
      const isParty =
        request.user.role === "admin" ||
        row.creator_id === request.user.userId ||
        row.freelancer_id === request.user.userId;

      if (!isParty) {
        throw new AppError(403, 403, "Forbidden");
      }

      const payload = request.body as z.infer<typeof reviewCommentSchema>;

      const created = await dbQuery<{
        id: string;
        content: string;
        comment_type: string;
        visibility: string;
        parent_comment_id: string | null;
        created_at: Date;
      }>(
        `
          INSERT INTO submission_review_comments (
            submission_id,
            revision_id,
            author_id,
            parent_comment_id,
            comment_type,
            visibility,
            content
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id, content, comment_type, visibility, parent_comment_id, created_at
        `,
        [
          request.params.id,
          payload.revisionId ?? null,
          request.user.userId,
          payload.parentCommentId ?? null,
          payload.commentType,
          payload.visibility,
          payload.content,
        ],
      );

      return response.status(201).json({ comment: created.rows[0] });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/:id/review-decision",
  requireAuth,
  validateParams(idSchema),
  validateBody(reviewDecisionSchema),
  async (request, response, next) => {
    try {
      if (!request.user) {
        throw new AppError(401, 401, "Unauthorized");
      }

      const candidate = await dbQuery<{
        submission_id: string;
        bounty_id: string;
        freelancer_id: string;
        creator_id: string;
        final_score: number | null;
      }>(
        `
          SELECT s.id AS submission_id,
                 s.bounty_id,
                 s.freelancer_id,
                 b.creator_id,
                 s.final_score
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
        throw new AppError(403, 403, "Only project client can set review decision");
      }

      const payload = request.body as z.infer<typeof reviewDecisionSchema>;
      const gateStatus =
        payload.decision === "approve"
          ? "approved"
          : payload.decision === "request_changes"
            ? "changes_requested"
            : "none";
      const nextStatus = payload.decision === "request_changes" ? "in_progress" : "submitted";

      await dbQuery(
        `
          UPDATE submissions
          SET review_gate_status = $2,
              status = $3,
              submission_stage = CASE WHEN $2 = 'changes_requested' THEN 'draft' ELSE submission_stage END,
              approved_for_payout_at = CASE WHEN $2 = 'approved' THEN NOW() ELSE NULL END,
              approved_for_payout_by = CASE WHEN $2 = 'approved' THEN $4 ELSE NULL END,
              last_client_comment = $5,
              updated_at = NOW()
          WHERE id = $1
        `,
        [request.params.id, gateStatus, nextStatus, request.user.userId, payload.comment],
      );

      await dbQuery(
        `
          INSERT INTO submission_review_comments (submission_id, author_id, comment_type, visibility, content)
          VALUES ($1, $2, $3, 'both', $4)
        `,
        [
          request.params.id,
          request.user.userId,
          payload.decision === "approve"
            ? "approve"
            : payload.decision === "request_changes"
              ? "request_changes"
              : "reject",
          payload.comment,
        ],
      );

      if (payload.decision === "approve" && row.final_score !== null) {
        await dbQuery(
          `
            UPDATE submissions
            SET status = 'validating',
                updated_at = NOW()
            WHERE id = $1
          `,
          [request.params.id],
        );

        await queuePayoutRelease({
          submissionId: request.params.id,
          bountyId: row.bounty_id,
          finalScore: row.final_score,
        });
      }

      return response.status(200).json({
        decision: payload.decision,
        gateStatus,
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
