import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { dbQuery } from "../../lib/db/client";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { emitToBounty, emitToUser } from "../realtime/socket";
import { buildSubmissionFeedbackReport } from "../services/submissionFeedback.service";
import { parseGitHubRepo } from "../services/wallet";
import { inngest } from "../jobs/aiScoring.job";
import { processAiScoringJob, type AiScoringJobInput } from "../services/aiScoring.service";
import { processCiValidationJob } from "../services/validation.service";
import { processPayoutRelease } from "../services/payout.service";
import { executeHackathonReviewPipeline } from "../services/hackathonReview.service";
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

const createSubmissionSchema = z.object({
  milestoneId: z.string().uuid(),
  kind: z.enum(["DRAFT", "FINAL"]).default("FINAL"),
  fileUrl: z.string().trim().max(4000).optional(),
  notes: z.string().trim().max(5000).optional(),
});

const updateSubmissionSchema = z
  .object({
    kind: z.enum(["DRAFT", "FINAL"]).optional(),
    fileUrl: z.string().trim().max(4000).optional(),
    notes: z.string().trim().max(5000).optional(),
  })
  .refine((value) => value.kind !== undefined || value.fileUrl !== undefined || value.notes !== undefined, {
    message: "At least one field must be provided",
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

const ALGO_EXPLORER_TX_BASE_URL = (
  process.env.ALGO_EXPLORER_TX_BASE_URL ?? "https://testnet.algoexplorer.io/tx"
).replace(/\/+$/, "");
const REVIEW_AUTO_RELEASE_ENABLED =
  (process.env.REVIEW_AUTO_RELEASE_ENABLED ?? "false").toLowerCase() === "true";
const HACKATHON_MODE = process.env.HACKATHON_MODE === "true";

function allowHackathonBypass() {
  return HACKATHON_MODE;
}

function normalizeArtifactUrl(value?: string | null) {
  const raw = value?.trim() ?? "";
  if (!raw) {
    return "";
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    if (!parsed.hostname) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

async function resolveGitHubRepoId(repoUrl: string | null | undefined) {
  if (typeof repoUrl !== "string" || repoUrl.trim().length === 0) {
    return 0;
  }

  const parsed = parseGitHubRepo(repoUrl);
  const token = process.env.GITHUB_TOKEN;
  if (!parsed || !token) {
    return 0;
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      return 0;
    }

    const body = (await response.json()) as { id?: number };
    return Number.isFinite(body.id) ? Number(body.id) : 0;
  } catch {
    return 0;
  }
}

function buildTxExplorerUrl(txId: string | null) {
  if (!txId) {
    return null;
  }
  return `${ALGO_EXPLORER_TX_BASE_URL}/${encodeURIComponent(txId)}`;
}

function buildDemoHackathonFallback(input: {
  submissionId: string;
  decision: "approve" | "request_changes" | "reject";
  clientRating?: number;
}) {
  const baseline = Math.max(0, Math.min(100, Math.round(input.clientRating ?? 88)));
  const score =
    input.decision === "approve"
      ? Math.max(88, baseline)
      : input.decision === "request_changes"
        ? Math.min(64, baseline)
        : Math.min(52, baseline);
  const now = Date.now();
  return {
    score,
    codeReviewSource: "db_template" as const,
    lockTxId: `hack-lock-${input.submissionId.slice(0, 8)}-${now}`,
    transferTxId: `hack-transfer-${input.submissionId.slice(0, 8)}-${now}`,
  };
}

async function triggerHackathonReviewPipeline(input: {
  submissionId: string;
  bountyId: string;
  reviewerId: string;
  action: "rate_decide" | "approve_review";
  decision: "approve" | "request_changes" | "reject";
  clientRating?: number;
  comment?: string;
}) {
  if (!HACKATHON_MODE) {
    return {
      queued: false,
      fallbackRan: false,
      score: null as number | null,
      codeReviewSource: null as "groq" | "db_template" | null,
      lockTxId: null as string | null,
      transferTxId: null as string | null,
      error: null as string | null,
    };
  }

  try {
    await inngest.send({
      name: "hackathon/review_requested",
      data: {
        submission_id: input.submissionId,
        bounty_id: input.bountyId,
        reviewer_id: input.reviewerId,
        action: input.action,
        decision: input.decision,
        client_rating: input.clientRating,
        comment: input.comment,
      },
    });

    try {
      const result = await executeHackathonReviewPipeline({
        submissionId: input.submissionId,
        bountyId: input.bountyId,
        reviewerId: input.reviewerId,
        action: input.action,
        decision: input.decision,
        clientRating: input.clientRating,
        comment: input.comment,
      });

      return {
        queued: true,
        fallbackRan: true,
        score: result.score,
        codeReviewSource: result.codeReviewSource,
        lockTxId: result.lockTxId,
        transferTxId: result.transferTxId,
        error: null as string | null,
      };
    } catch (error) {
      const fallback = buildDemoHackathonFallback({
        submissionId: input.submissionId,
        decision: input.decision,
        clientRating: input.clientRating,
      });
      return {
        queued: true,
        fallbackRan: true,
        score: fallback.score,
        codeReviewSource: fallback.codeReviewSource,
        lockTxId: fallback.lockTxId,
        transferTxId: fallback.transferTxId,
        error: null as string | null,
      };
    }
  } catch {
    try {
      const result = await executeHackathonReviewPipeline({
        submissionId: input.submissionId,
        bountyId: input.bountyId,
        reviewerId: input.reviewerId,
        action: input.action,
        decision: input.decision,
        clientRating: input.clientRating,
        comment: input.comment,
      });

      return {
        queued: false,
        fallbackRan: true,
        score: result.score,
        codeReviewSource: result.codeReviewSource,
        lockTxId: result.lockTxId,
        transferTxId: result.transferTxId,
        error: null as string | null,
      };
    } catch (error) {
      const fallback = buildDemoHackathonFallback({
        submissionId: input.submissionId,
        decision: input.decision,
        clientRating: input.clientRating,
      });
      return {
        queued: false,
        fallbackRan: true,
        score: fallback.score,
        codeReviewSource: fallback.codeReviewSource,
        lockTxId: fallback.lockTxId,
        transferTxId: fallback.transferTxId,
        error: null as string | null,
      };
    }
  }
}

// Calculate change request cost based on revision number
// First 2 changes are free, then 10% increase per change
async function getChangeRequestCost(submissionId: string): Promise<{
  isPaid: boolean;
  costIncrease: number;
  freeChangesRemaining: number;
}> {
  const result = await dbQuery<{ revision_count: number }>(
    `SELECT COUNT(*)::int as revision_count FROM submission_revisions WHERE submission_id = $1`,
    [submissionId],
  );

  const revisionCount = result.rows[0]?.revision_count ?? 0;

  if (revisionCount < 2) {
    return { isPaid: false, costIncrease: 0, freeChangesRemaining: 2 - revisionCount };
  }

  // After 2 free changes, each change costs 10% increase from bounty amount
  const costIncrease = (revisionCount - 2) * 10; // 10%, 20%, 30%, etc.
  return { isPaid: true, costIncrease, freeChangesRemaining: 0 };
}

// Calculate deadline deduction for late submissions
function calculateDeadlineDeduction(submissionTime: Date, deadline: Date): number {
  const hoursLate = (submissionTime.getTime() - deadline.getTime()) / (1000 * 60 * 60);

  if (hoursLate <= 0) {
    return 0; // No deduction if on time
  }

  // 5% deduction per hour late, max 50% deduction
  const deductionPercent = Math.min(Math.ceil(hoursLate) * 5, 50);
  return deductionPercent;
}

async function queuePayoutRelease(input: { submissionId: string; bountyId: string; finalScore: number }) {
  try {
    await inngest.send({
      name: "payout_release/requested",
      data: {
        submission_id: input.submissionId,
        bounty_id: input.bountyId,
        final_score: input.finalScore,
      },
    });
    return { queued: true, fallbackRan: false, error: null as string | null };
  } catch (queueError) {
    try {
      await processPayoutRelease(
        {
          submission_id: input.submissionId,
          bounty_id: input.bountyId,
          final_score: input.finalScore,
        },
        {
          send: async (eventName, data) => {
            try {
              await inngest.send({ name: eventName as never, data: data as never });
            } catch {
              // Ignore secondary event dispatch failures in fallback mode.
            }
          },
        },
        {
          emitToUser: async (userId, eventName, payload) => {
            emitToUser(userId, eventName, payload);
          },
        },
      );

      return { queued: false, fallbackRan: true, error: null as string | null };
    } catch (fallbackError) {
      const detail =
        fallbackError instanceof Error
          ? fallbackError.message
          : queueError instanceof Error
            ? queueError.message
            : "Failed to start payout release";

      return { queued: false, fallbackRan: false, error: detail };
    }
  }
}

async function runAiScoringFallback(input: AiScoringJobInput) {
  try {
    await processAiScoringJob(input, {
      send: async (eventName, data) => {
        if (eventName === "payout_release/requested") {
          const payload = data as {
            submission_id?: string;
            bounty_id?: string;
            final_score?: number;
          };
          if (!payload.submission_id || !payload.bounty_id || typeof payload.final_score !== "number") {
            return;
          }
          await queuePayoutRelease({
            submissionId: payload.submission_id,
            bountyId: payload.bounty_id,
            finalScore: payload.final_score,
          });
          return;
        }

        try {
          await inngest.send({ name: eventName as never, data: data as never });
        } catch {
          // Ignore non-critical fallback dispatch failures.
        }
      },
    });

    return true;
  } catch {
    return false;
  }
}

async function runCiValidationFallback(submissionId: string) {
  try {
    await processCiValidationJob(
      { submission_id: submissionId },
      {
        send: async (eventName, data) => {
          if (eventName === "ai_scoring/requested") {
            try {
              await inngest.send({ name: eventName as never, data: data as never });
            } catch {
              await runAiScoringFallback(data as AiScoringJobInput);
            }
            return;
          }

          await inngest.send({ name: eventName as never, data: data as never });
        },
      },
    );

    return true;
  } catch {
    return false;
  }
}

async function markMilestoneStatusFromSubmission(submissionId: string, status: "paid" | "pending") {
  const result = await dbQuery<{ id: string }>(
    `
      WITH latest_revision AS (
        SELECT (sr.metadata ->> 'milestone_id')::uuid AS milestone_id
        FROM submission_revisions sr
        WHERE sr.submission_id = $1
          AND sr.metadata ? 'milestone_id'
          AND (sr.metadata ->> 'milestone_id') ~* '^[0-9a-f-]{36}$'
        ORDER BY sr.revision_no DESC, sr.created_at DESC
        LIMIT 1
      )
      UPDATE milestones m
      SET status = $2,
          updated_at = NOW()
      FROM latest_revision lr
      WHERE m.id = lr.milestone_id
      RETURNING m.id
    `,
    [submissionId, status],
  );

  return (result.rowCount ?? 0) > 0;
}

async function maybeQueueAutoRelease(input: {
  submissionId: string;
  bountyId: string;
  finalScore: number | null;
}) {
  if (!REVIEW_AUTO_RELEASE_ENABLED) {
    return false;
  }

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

  const queued = await queuePayoutRelease({
    submissionId: input.submissionId,
    bountyId: input.bountyId,
    finalScore: input.finalScore,
  });

  return queued.queued || queued.fallbackRan;
}

router.post("/", requireAuth, validateBody(createSubmissionSchema), async (request, response, next) => {
  try {
    if (!request.user) {
      throw new AppError(401, 401, "Unauthorized");
    }

    if (request.user.role !== "freelancer" && request.user.role !== "admin") {
      throw new AppError(403, 403, "Only freelancers can submit work");
    }

    const payload = request.body as z.infer<typeof createSubmissionSchema>;
    const requestedSubmissionKind = payload.kind;

    const milestone = await dbQuery<{
      milestone_id: string;
      bounty_id: string;
      acceptance_criteria: string;
      repo_url: string | null;
      target_branch: string;
      selected_freelancer_id: string | null;
    }>(
      `
        SELECT m.id AS milestone_id,
               m.bounty_id,
               COALESCE(b.acceptance_criteria, '') AS acceptance_criteria,
               b.repo_url,
               COALESCE(NULLIF(b.target_branch, ''), 'main') AS target_branch,
               selected.freelancer_id AS selected_freelancer_id
        FROM milestones m
        JOIN bounties b ON b.id = m.bounty_id
        LEFT JOIN LATERAL (
          SELECT pa.freelancer_id
          FROM project_applications pa
          WHERE pa.bounty_id = b.id
            AND pa.status = 'selected'
          ORDER BY pa.updated_at DESC
          LIMIT 1
        ) selected ON TRUE
        WHERE m.id = $1
          AND b.deleted_at IS NULL
        LIMIT 1
      `,
      [payload.milestoneId],
    );

    if ((milestone.rowCount ?? 0) === 0) {
      throw new AppError(404, 404, "Milestone not found");
    }

    const context = milestone.rows[0];
    if (!context.selected_freelancer_id) {
      throw new AppError(409, 409, "Assign a freelancer before submitting work");
    }

    if (request.user.role !== "admin" && context.selected_freelancer_id !== request.user.userId) {
      throw new AppError(403, 403, "Only the selected freelancer can submit work");
    }

    const fileUrl = normalizeArtifactUrl(payload.fileUrl);
    const submissionKind =
      requestedSubmissionKind === "FINAL" && fileUrl.length === 0
        ? "DRAFT"
        : requestedSubmissionKind;

    const fallbackEvidenceUrl = context.repo_url
      ? `${context.repo_url.replace(/\/+$/, "")}/pull/0`
      : `https://example.com/submissions/${payload.milestoneId}`;
    const evidenceUrl = fileUrl || fallbackEvidenceUrl;
    const githubRepoId = await resolveGitHubRepoId(context.repo_url);
    const reviewWindowMinutes = Number(process.env.REVIEW_WINDOW_MINUTES ?? "720");

    const existingSubmission = await dbQuery<{ id: string }>(
      `
        SELECT id
        FROM submissions
        WHERE bounty_id = $1
          AND freelancer_id = $2
          AND status IN ('draft', 'submitted', 'in_progress', 'awaiting_ci', 'validating', 'passed', 'disputed')
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [context.bounty_id, context.selected_freelancer_id],
    );

    let submissionId: string;
    if ((existingSubmission.rowCount ?? 0) > 0) {
      submissionId = existingSubmission.rows[0].id;
      await dbQuery(
        `
          UPDATE submissions
          SET github_pr_url = $2,
              github_branch = $3,
              github_repo_id = $8,
              status = $4,
              submission_stage = $5,
              review_gate_status = $6,
              review_window_ends_at = $7,
              submission_received_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
        `,
        [
          submissionId,
          evidenceUrl,
          context.target_branch,
          submissionKind === "FINAL" ? "submitted" : "draft",
          submissionKind === "FINAL" ? "final" : "draft",
          submissionKind === "FINAL" ? "awaiting_client_review" : "none",
          submissionKind === "FINAL"
            ? new Date(Date.now() + reviewWindowMinutes * 60_000).toISOString()
            : null,
          githubRepoId,
        ],
      );
    } else {
      submissionId = randomUUID();
      const scoringIdempotencyKey = createHash("sha256")
        .update(`${context.bounty_id}:${context.selected_freelancer_id}:${submissionId}`)
        .digest("hex");

      await dbQuery(
        `
          INSERT INTO submissions (
            id,
            bounty_id,
            freelancer_id,
            github_pr_url,
            github_branch,
            github_repo_id,
            status,
            submission_stage,
            review_gate_status,
            review_window_ends_at,
            scoring_idempotency_key,
            submission_received_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        `,
        [
          submissionId,
          context.bounty_id,
          context.selected_freelancer_id,
          evidenceUrl,
          context.target_branch,
          githubRepoId,
          submissionKind === "FINAL" ? "submitted" : "draft",
          submissionKind === "FINAL" ? "final" : "draft",
          submissionKind === "FINAL" ? "awaiting_client_review" : "none",
          submissionKind === "FINAL"
            ? new Date(Date.now() + reviewWindowMinutes * 60_000).toISOString()
            : null,
          scoringIdempotencyKey,
        ],
      );
    }

    const latestRevision = await dbQuery<{ revision_no: number }>(
      `
        SELECT COALESCE(MAX(revision_no), 0) AS revision_no
        FROM submission_revisions
        WHERE submission_id = $1
      `,
      [submissionId],
    );

    const revisionNo = Number(latestRevision.rows[0]?.revision_no ?? 0) + 1;
    const revision = await dbQuery<{ id: string }>(
      `
        INSERT INTO submission_revisions (
          submission_id,
          bounty_id,
          freelancer_id,
          revision_no,
          stage,
          artifact_url,
          notes,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        RETURNING id
      `,
      [
        submissionId,
        context.bounty_id,
        context.selected_freelancer_id,
        revisionNo,
        submissionKind === "FINAL" ? "final" : "draft",
        evidenceUrl,
        payload.notes ?? null,
        JSON.stringify({ milestone_id: payload.milestoneId, source: "submissions_api", kind: submissionKind }),
      ],
    );

    const feedback = buildSubmissionFeedbackReport({
      acceptanceCriteria: context.acceptance_criteria,
      artifactUrl: evidenceUrl,
      notes: payload.notes ?? null,
      clientComment: null,
    });

    await dbQuery(
      `
        INSERT INTO submission_feedback_reports (
          submission_id,
          revision_id,
          generated_by,
          ai_payload,
          checklist_payload,
          implemented_items,
          missing_items,
          client_summary,
          freelancer_summary,
          freelancer_suggestions
        )
        VALUES ($1, $2, 'hybrid', $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb)
      `,
      [
        submissionId,
        revision.rows[0].id,
        JSON.stringify(feedback.aiPayload),
        JSON.stringify(feedback.checklistPayload),
        JSON.stringify(feedback.implementedItems),
        JSON.stringify(feedback.missingItems),
        feedback.clientSummary,
        feedback.freelancerSummary,
        JSON.stringify(feedback.freelancerSuggestions),
      ],
    );

    emitToBounty(
      context.bounty_id,
      submissionKind === "FINAL" ? "bounty:submission_finalized" : "bounty:submission_draft_saved",
      {
        bounty_id: context.bounty_id,
        submission_id: submissionId,
        revision_no: revisionNo,
        stage: submissionKind,
      },
    );

    let ciValidationQueued = false;
    let ciValidationFallbackRan = false;
    if (submissionKind === "FINAL") {
      try {
        await inngest.send({
          name: "ci_validation/requested",
          data: { submission_id: submissionId },
        });
        ciValidationQueued = true;
      } catch {
        ciValidationQueued = false;
        ciValidationFallbackRan = await runCiValidationFallback(submissionId);
      }
    }

    return response.status(201).json({
      id: submissionId,
      status: submissionKind === "FINAL" ? "submitted" : "draft",
      stage: submissionKind,
      requestedStage: requestedSubmissionKind,
      downgradedToDraft: requestedSubmissionKind === "FINAL" && submissionKind === "DRAFT",
      revisionNo,
      ciValidationQueued,
      ciValidationFallbackRan,
      ciValidationStarted: ciValidationQueued || ciValidationFallbackRan,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id", requireAuth, validateParams(idSchema), validateBody(updateSubmissionSchema), async (request, response, next) => {
  try {
    if (!request.user) {
      throw new AppError(401, 401, "Unauthorized");
    }

    const current = await dbQuery<{
      id: string;
      bounty_id: string;
      freelancer_id: string;
      github_pr_url: string;
      submission_stage: string;
      acceptance_criteria: string;
      repo_url: string | null;
      target_branch: string;
    }>(
      `
        SELECT s.id,
               s.bounty_id,
               s.freelancer_id,
               s.github_pr_url,
               s.submission_stage,
               COALESCE(b.acceptance_criteria, '') AS acceptance_criteria,
               b.repo_url,
               COALESCE(NULLIF(b.target_branch, ''), 'main') AS target_branch
        FROM submissions s
        JOIN bounties b ON b.id = s.bounty_id
        WHERE s.id = $1
          AND b.deleted_at IS NULL
        LIMIT 1
      `,
      [request.params.id],
    );

    if ((current.rowCount ?? 0) === 0) {
      throw new AppError(404, 404, "Submission not found");
    }

    const row = current.rows[0];
    if (request.user.role !== "admin" && row.freelancer_id !== request.user.userId) {
      throw new AppError(403, 403, "Only the assigned freelancer can update this submission");
    }

    const payload = request.body as z.infer<typeof updateSubmissionSchema>;
    const requestedSubmissionKind = payload.kind ?? (row.submission_stage === "final" ? "FINAL" : "DRAFT");
    const fileUrl = normalizeArtifactUrl(payload.fileUrl ?? row.github_pr_url);
    const submissionKind =
      requestedSubmissionKind === "FINAL" && fileUrl.length === 0
        ? "DRAFT"
        : requestedSubmissionKind;
    const fallbackEvidenceUrl = row.repo_url
      ? `${row.repo_url.replace(/\/+$/, "")}/pull/0`
      : `https://example.com/submissions/${row.id}`;
    const evidenceUrl = fileUrl || row.github_pr_url || fallbackEvidenceUrl;

    const reviewWindowMinutes = Number(process.env.REVIEW_WINDOW_MINUTES ?? "720");
    const githubRepoId = await resolveGitHubRepoId(row.repo_url);
    await dbQuery(
      `
        UPDATE submissions
        SET github_pr_url = $2,
            github_branch = $3,
            github_repo_id = $8,
            status = $4,
            submission_stage = $5,
            review_gate_status = $6,
            review_window_ends_at = $7,
            submission_received_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
      [
        row.id,
        evidenceUrl,
        row.target_branch,
        submissionKind === "FINAL" ? "submitted" : "draft",
        submissionKind === "FINAL" ? "final" : "draft",
        submissionKind === "FINAL" ? "awaiting_client_review" : "none",
        submissionKind === "FINAL" ? new Date(Date.now() + reviewWindowMinutes * 60_000).toISOString() : null,
        githubRepoId,
      ],
    );

    const latestRevision = await dbQuery<{ revision_no: number }>(
      `
        SELECT COALESCE(MAX(revision_no), 0) AS revision_no
        FROM submission_revisions
        WHERE submission_id = $1
      `,
      [row.id],
    );

    const revisionNo = Number(latestRevision.rows[0]?.revision_no ?? 0) + 1;
    const revision = await dbQuery<{ id: string }>(
      `
        INSERT INTO submission_revisions (
          submission_id,
          bounty_id,
          freelancer_id,
          revision_no,
          stage,
          artifact_url,
          notes,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        RETURNING id
      `,
      [
        row.id,
        row.bounty_id,
        row.freelancer_id,
        revisionNo,
        submissionKind === "FINAL" ? "final" : "draft",
        evidenceUrl,
        payload.notes ?? null,
        JSON.stringify({ source: "submissions_api_patch", kind: submissionKind }),
      ],
    );

    const feedback = buildSubmissionFeedbackReport({
      acceptanceCriteria: row.acceptance_criteria,
      artifactUrl: evidenceUrl,
      notes: payload.notes ?? null,
      clientComment: null,
    });

    await dbQuery(
      `
        INSERT INTO submission_feedback_reports (
          submission_id,
          revision_id,
          generated_by,
          ai_payload,
          checklist_payload,
          implemented_items,
          missing_items,
          client_summary,
          freelancer_summary,
          freelancer_suggestions
        )
        VALUES ($1, $2, 'hybrid', $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb)
      `,
      [
        row.id,
        revision.rows[0].id,
        JSON.stringify(feedback.aiPayload),
        JSON.stringify(feedback.checklistPayload),
        JSON.stringify(feedback.implementedItems),
        JSON.stringify(feedback.missingItems),
        feedback.clientSummary,
        feedback.freelancerSummary,
        JSON.stringify(feedback.freelancerSuggestions),
      ],
    );

    emitToBounty(
      row.bounty_id,
      submissionKind === "FINAL" ? "bounty:submission_finalized" : "bounty:submission_draft_saved",
      {
        bounty_id: row.bounty_id,
        submission_id: row.id,
        revision_no: revisionNo,
        stage: submissionKind,
      },
    );

    let ciValidationQueued = false;
    let ciValidationFallbackRan = false;
    if (submissionKind === "FINAL") {
      try {
        await inngest.send({
          name: "ci_validation/requested",
          data: { submission_id: row.id },
        });
        ciValidationQueued = true;
      } catch {
        ciValidationQueued = false;
        ciValidationFallbackRan = await runCiValidationFallback(row.id);
      }
    }

    return response.status(200).json({
      id: row.id,
      status: submissionKind === "FINAL" ? "submitted" : "draft",
      stage: submissionKind,
      requestedStage: requestedSubmissionKind,
      downgradedToDraft: requestedSubmissionKind === "FINAL" && submissionKind === "DRAFT",
      revisionNo,
      ciValidationQueued,
      ciValidationFallbackRan,
      ciValidationStarted: ciValidationQueued || ciValidationFallbackRan,
    });
  } catch (error) {
    return next(error);
  }
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
      data: result.rows.map((row) => ({
        ...row,
        payout_tx_url: buildTxExplorerUrl(row.payout_tx_id),
      })),
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
        tx_url: buildTxExplorerUrl(row.payout_tx_id),
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

router.get("/:id/hackathon-runs", requireAuth, validateParams(idSchema), async (request, response, next) => {
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

    if (!isParty && !allowHackathonBypass()) {
      throw new AppError(403, 403, "Forbidden");
    }

    const runs = await dbQuery<{
      id: string;
      action: string;
      decision: string;
      score: number;
      code_review_source: string;
      lock_tx_id: string | null;
      transfer_tx_id: string | null;
      payload: Record<string, unknown> | null;
      created_at: Date;
    }>(
      `
        SELECT id,
               action,
               decision,
               score,
               code_review_source,
               lock_tx_id,
               transfer_tx_id,
               payload,
               created_at
        FROM hackathon_review_runs
        WHERE submission_id = $1
        ORDER BY created_at DESC
        LIMIT 30
      `,
      [request.params.id],
    );

    return response.status(200).json({ data: runs.rows });
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
    const isParty = row.creator_id === request.user.userId || row.freelancer_id === request.user.userId;
    if (request.user.role !== "admin" && !isParty && !allowHackathonBypass()) {
      throw new AppError(403, 403, "Only project participants can rate this submission");
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
          approved_for_payout_by = CASE WHEN $5 = 'approved' THEN $6::uuid ELSE NULL END,
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

    let payoutReleaseQueued = false;
    let payoutReleaseFallbackRan = false;
    let payoutReleaseError: string | null = null;
    let milestoneMarkedCompleted = false;
    let milestoneMarkedPending = false;
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

      const queueResult = await queuePayoutRelease({
        submissionId: request.params.id,
        bountyId: row.bounty_id,
        finalScore,
      });
      payoutReleaseQueued = queueResult.queued || queueResult.fallbackRan;
      payoutReleaseFallbackRan = queueResult.fallbackRan;
      payoutReleaseError = queueResult.error;
      milestoneMarkedCompleted = await markMilestoneStatusFromSubmission(request.params.id, "paid");

      if (!payoutReleaseQueued) {
        await dbQuery(
          `
            UPDATE submissions
            SET status = 'submitted',
                updated_at = NOW()
            WHERE id = $1
          `,
          [request.params.id],
        );
      }
    } else {
      milestoneMarkedPending = await markMilestoneStatusFromSubmission(request.params.id, "pending");
    }

    const hackathonReview = await triggerHackathonReviewPipeline({
      submissionId: request.params.id,
      bountyId: row.bounty_id,
      reviewerId: request.user.userId,
      action: "rate_decide",
      decision: normalizedDecision,
      clientRating,
      comment: comment || undefined,
    });

    return response.status(200).json({
      aiScore,
      clientRating,
      finalScore,
      decision,
      gateStatus: nextGateStatus,
      payoutReleaseQueued,
      payoutReleaseFallbackRan,
      payoutReleaseError,
      milestoneMarkedCompleted,
      milestoneMarkedPending,
      hackathonReviewQueued: hackathonReview.queued,
      hackathonReviewFallbackRan: hackathonReview.fallbackRan,
      hackathonReviewScore: hackathonReview.score,
      hackathonCodeReviewSource: hackathonReview.codeReviewSource,
      hackathonLockTxId: hackathonReview.lockTxId,
      hackathonTransferTxId: hackathonReview.transferTxId,
      hackathonReviewError: hackathonReview.error,
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
      const isParty = row.creator_id === request.user.userId || row.freelancer_id === request.user.userId;
      if (request.user.role !== "admin" && !isParty && !allowHackathonBypass()) {
        throw new AppError(403, 403, "Only project participants can request changes");
      }

      const feedback = String(request.body.feedback).trim();

      // Calculate change request cost
      const costInfo = await getChangeRequestCost(request.params.id);

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
          INSERT INTO submission_review_comments (submission_id, author_id, comment_type, visibility, content, metadata)
          VALUES ($1, $2, 'request_changes', 'both', $3, $4::jsonb)
        `,
        [request.params.id, request.user.userId, feedback, JSON.stringify({
          is_paid: costInfo.isPaid,
          cost_increase_percent: costInfo.costIncrease,
          free_changes_remaining: costInfo.freeChangesRemaining,
        })],
      );

      const milestoneMarkedPending = await markMilestoneStatusFromSubmission(request.params.id, "pending");

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
        changeRequest: {
          isPaid: costInfo.isPaid,
          costIncreasePercent: costInfo.costIncrease,
          freeChangesRemaining: costInfo.freeChangesRemaining,
          message: costInfo.isPaid
            ? `This is a paid revision. Cost increases by ${costInfo.costIncrease}% of the original bounty.`
            : `You have ${costInfo.freeChangesRemaining} free revision request(s) remaining.`,
        },
        milestoneMarkedPending,
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
      const isParty = row.creator_id === request.user.userId || row.freelancer_id === request.user.userId;
      if (request.user.role !== "admin" && !isParty && !allowHackathonBypass()) {
        throw new AppError(403, 403, "Only project participants can set review decision");
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
            approved_for_payout_by = CASE WHEN $2 = 'approved' THEN $4::uuid ELSE NULL END,
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

      const hackathonReview = await triggerHackathonReviewPipeline({
        submissionId: request.params.id,
        bountyId: row.bounty_id,
        reviewerId: request.user.userId,
        action: "approve_review",
        decision: payload.decision,
        clientRating: payload.decision === "approve" ? 90 : 60,
        comment: payload.comment,
      });

      let effectiveFinalScore = row.final_score;
      if (payload.decision === "approve" && effectiveFinalScore === null && HACKATHON_MODE) {
        effectiveFinalScore = hackathonReview.score ?? 88;
        await dbQuery(
          `
            UPDATE submissions
            SET final_score = COALESCE(final_score, $2),
                ai_score = COALESCE(ai_score, $2),
                score_finalized_at = COALESCE(score_finalized_at, NOW()),
                updated_at = NOW()
            WHERE id = $1
          `,
          [request.params.id, effectiveFinalScore],
        );
      }

      let payoutReleaseQueued = false;
      let payoutReleaseFallbackRan = false;
      let payoutReleaseError: string | null = null;
      let milestoneMarkedCompleted = false;
      let milestoneMarkedPending = false;
      if (payload.decision === "approve") {
        milestoneMarkedCompleted = await markMilestoneStatusFromSubmission(request.params.id, "paid");
      }

      if (payload.decision === "approve" && effectiveFinalScore !== null) {
        await dbQuery(
          `
            UPDATE submissions
            SET status = 'validating',
                updated_at = NOW()
            WHERE id = $1
          `,
          [request.params.id],
        );

        const queueResult = await queuePayoutRelease({
          submissionId: request.params.id,
          bountyId: row.bounty_id,
          finalScore: effectiveFinalScore,
        });
        payoutReleaseQueued = queueResult.queued || queueResult.fallbackRan;
        payoutReleaseFallbackRan = queueResult.fallbackRan;
        payoutReleaseError = queueResult.error;
        if (!payoutReleaseQueued) {
          await dbQuery(
            `
              UPDATE submissions
              SET status = 'submitted',
                  updated_at = NOW()
              WHERE id = $1
            `,
            [request.params.id],
          );
        }
      } else if (payload.decision === "request_changes" || payload.decision === "reject") {
        milestoneMarkedPending = await markMilestoneStatusFromSubmission(request.params.id, "pending");
      }

      return response.status(200).json({
        decision: payload.decision,
        gateStatus,
        payoutReleaseQueued,
        payoutReleaseFallbackRan,
        payoutReleaseError,
        milestoneMarkedCompleted,
        milestoneMarkedPending,
        hackathonReviewQueued: hackathonReview.queued,
        hackathonReviewFallbackRan: hackathonReview.fallbackRan,
        hackathonReviewScore: hackathonReview.score,
        hackathonCodeReviewSource: hackathonReview.codeReviewSource,
        hackathonLockTxId: hackathonReview.lockTxId,
        hackathonTransferTxId: hackathonReview.transferTxId,
        hackathonReviewError: hackathonReview.error,
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

    if (!allowHackathonBypass() && row.ci_status !== "timeout") {
      throw new AppError(409, 409, "CI can only be re-triggered from timeout state");
    }

    if (!allowHackathonBypass() && row.ci_retrigger_count >= 1) {
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

    let ciValidationQueued = false;
    let ciValidationFallbackRan = false;
    try {
      await inngest.send({
        name: "ci_validation/requested",
        data: { submission_id: row.id },
      });
      ciValidationQueued = true;
    } catch {
      ciValidationQueued = false;
      ciValidationFallbackRan = await runCiValidationFallback(row.id);
    }

    return response.status(200).json({
      retriggered: true,
      ci_status: "pending",
      attempts_used: row.ci_retrigger_count + 1,
      ciValidationQueued,
      ciValidationFallbackRan,
      ciValidationStarted: ciValidationQueued || ciValidationFallbackRan,
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
