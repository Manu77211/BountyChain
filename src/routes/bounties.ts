import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { dbQuery } from "../../lib/db/client";
import { acceptBountyWithRowLock } from "../../lib/db/queries";
import type { BountyRow, BountyStatus } from "../../lib/db/types";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { perIpRateLimiter } from "../middleware/rateLimiter";
import { sanctionsMiddleware } from "../middleware/sanctions";
import { validateBody, validateParams, validateQuery } from "../middleware/validate";
import {
  acceptBountySchema,
  bountyListQuerySchema,
  createBountySchema,
  extendDeadlineSchema,
  fundBountyParamsSchema,
  idParamSchema,
  raiseBountyAmountSchema,
} from "../schemas/bounty.schema";
import { emitToBounty, emitToUser } from "../realtime/socket";
import { AlgorandService } from "../services/algorand";
import { parseGitHubRepo } from "../services/wallet";

const router = Router();
const algorand = new AlgorandService();

function requireUser(request: Parameters<typeof requireAuth>[0]) {
  if (!request.user) {
    throw new AppError(401, 401, "Unauthorized");
  }
  return request.user;
}

const BOUNTY_SELECT_COLUMNS = [
  "id",
  "creator_id",
  "title",
  "description",
  "acceptance_criteria",
  "repo_url",
  "target_branch",
  "allowed_languages",
  "total_amount",
  "escrow_contract_address",
  "escrow_locked",
  "status",
  "scoring_mode",
  "ai_score_threshold",
  "max_freelancers",
  "deadline",
  "grace_period_minutes",
  "extension_count",
  "idempotency_key",
  "created_at",
  "updated_at",
  "deleted_at",
].join(", ");

router.post("/", requireAuth, validateBody(createBountySchema), async (request, response, next) => {
  try {
    if (!request.user) {
      throw new AppError(401, 401, "Unauthorized");
    }

    const body = request.body;
    const idempotencyKey = createBountyIdempotencyKey(request.user.walletAddress, body.title);

    const existing = await getBountyByIdempotencyKey(idempotencyKey);
    if (existing) {
      return response.status(200).json({
        bounty: existing,
        idempotent: true,
      });
    }

    const repoInfo = parseGitHubRepo(body.repo_url);
    if (!repoInfo) {
      throw new AppError(400, 400, "repo_url must point to a GitHub repository");
    }

    const installed = await verifyGitHubAppInstalled(repoInfo.owner, repoInfo.repo);
    if (!installed) {
      throw new AppError(400, 400, "GH-C-001: GitHub App installation was not found for this repository");
    }

    const warnings: string[] = [];
    const isHackathonMode = process.env.HACKATHON_MODE === "true";
    const hasWorkflows = await checkGitHubActionsWorkflows(repoInfo.owner, repoInfo.repo);
    if (!hasWorkflows && !isHackathonMode) {
      warnings.push("GH-C-003: GitHub Actions workflow is missing for this repository");
    }

    if (body.deadline.getTime() - Date.now() < 24 * 60 * 60 * 1000) {
      warnings.push("DL-C-003: Deadline is less than 24 hours");
    }

    const insertSql = `
      INSERT INTO bounties (
        creator_id,
        title,
        description,
        acceptance_criteria,
        repo_url,
        target_branch,
        allowed_languages,
        total_amount,
        status,
        scoring_mode,
        ai_score_threshold,
        max_freelancers,
        deadline,
        idempotency_key
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, 'draft', $9,
        $10, $11, $12, $13
      )
      RETURNING ${BOUNTY_SELECT_COLUMNS}
    `;

    const params = [
      request.user.userId,
      body.title,
      body.description,
      body.acceptance_criteria,
      body.repo_url,
      body.target_branch,
      body.allowed_languages,
      body.total_amount.toString(),
      body.scoring_mode,
      body.ai_score_threshold,
      body.max_freelancers,
      body.deadline.toISOString(),
      idempotencyKey,
    ];

    try {
      const inserted = await dbQuery(insertSql, params);
      return response.status(201).json({
        bounty: inserted.rows[0],
        warnings,
      });
    } catch (error: unknown) {
      const maybePg = error as { code?: string };
      if (maybePg.code === "23505") {
        const existingByKey = await getBountyByIdempotencyKey(idempotencyKey);
        if (existingByKey) {
          return response.status(200).json({
            bounty: existingByKey,
            idempotent: true,
            warnings,
          });
        }
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

router.post(
  "/:id/fund",
  requireAuth,
  sanctionsMiddleware("bounties.fund"),
  validateParams(fundBountyParamsSchema),
  async (request, response, next) => {
    try {
      if (!request.user) {
        throw new AppError(401, 401, "Unauthorized");
      }

      const bounty = await getBountyById(request.params.id);
      if (!bounty) {
        throw new AppError(404, 404, "Bounty not found");
      }
      assertBountyIsActionable(bounty, "fund");
      if (bounty.creator_id !== request.user.userId) {
        throw new AppError(403, 403, "Only the bounty creator can fund escrow");
      }
      if (bounty.status === "open") {
        return response.status(200).json({
          bounty,
          tx_id: null,
          already_open: true,
        });
      }
      if (!new Set(["draft", "pending_escrow"]).has(bounty.status)) {
        throw new AppError(409, 409, "Bounty must be in draft or pending_escrow status before funding");
      }

      await algorand.assertWalletHasEscrowBalance(
        request.user.walletAddress,
        BigInt(bounty.total_amount),
        2_000n,
      );

      try {
        const escrow = await algorand.createBountyEscrowWithRetry({
          bountyId: bounty.id,
          creatorWallet: request.user.walletAddress,
          creatorUserId: request.user.userId,
          amountMicroAlgo: BigInt(bounty.total_amount),
        });

        const fundedSql = `
          UPDATE bounties
          SET escrow_locked = TRUE,
              escrow_contract_address = $1,
              status = 'open'
          WHERE id = $2
            AND deleted_at IS NULL
          RETURNING ${BOUNTY_SELECT_COLUMNS}
        `;

        const funded = await dbQuery(fundedSql, [escrow.contractAddress, bounty.id]);

        emitToBounty(bounty.id, "bounty:funded", {
          bounty_id: bounty.id,
          tx_id: escrow.txId,
          escrow_contract_address: escrow.contractAddress,
        });

        return response.status(200).json({
          bounty: funded.rows[0],
          tx_id: escrow.txId,
        });
      } catch (error) {
        await dbQuery(
          "UPDATE bounties SET status = 'pending_escrow' WHERE id = $1 AND deleted_at IS NULL",
          [bounty.id],
        );

        return response.status(502).json({
          error: "Escrow funding failed",
          code: 502,
          detail:
            error instanceof Error
              ? error.message.includes("SC-C-004")
                ? error.message
                : `SC-C-002: ${error.message}`
              : "SC-C-002: Unknown escrow funding failure",
        });
      }
    } catch (error) {
      return next(error);
    }
  },
);

router.get("/", perIpRateLimiter, validateQuery(bountyListQuerySchema), async (request, response, next) => {
  try {
    const query = request.query as unknown as {
      status?: BountyStatus;
      language?: string;
      min_amount?: bigint;
      max_amount?: bigint;
      sort_by: "deadline" | "amount" | "created";
      sort_order: "asc" | "desc";
      limit: number;
      cursor?: string;
    };

    const sortColumn =
      query.sort_by === "deadline"
        ? "deadline"
        : query.sort_by === "amount"
          ? "total_amount"
          : "created_at";

    const params: unknown[] = [];
    const where: string[] = ["deleted_at IS NULL", "status != 'draft'"];

    if (query.status) {
      params.push(query.status);
      where.push(`status = $${params.length}`);
    }
    if (query.language) {
      params.push(query.language.toLowerCase());
      where.push(`LOWER($${params.length}) = ANY (SELECT LOWER(x) FROM unnest(allowed_languages) AS x)`);
    }
    if (query.min_amount !== undefined) {
      params.push(query.min_amount.toString());
      where.push(`total_amount >= $${params.length}::bigint`);
    }
    if (query.max_amount !== undefined) {
      params.push(query.max_amount.toString());
      where.push(`total_amount <= $${params.length}::bigint`);
    }

    const cursor = decodeCursor(query.cursor);
    if (cursor && cursor.sortValue) {
      params.push(cursor.sortValue, cursor.id);
      const op = query.sort_order === "asc" ? ">" : "<";
      where.push(`(${sortColumn}, id) ${op} ($${params.length - 1}, $${params.length})`);
    }

    params.push(query.limit + 1);

    const sql = `
      SELECT ${BOUNTY_SELECT_COLUMNS}
      FROM bounties
      WHERE ${where.join(" AND ")}
      ORDER BY ${sortColumn} ${query.sort_order.toUpperCase()}, id ${query.sort_order.toUpperCase()}
      LIMIT $${params.length}
    `;

    const listed = await dbQuery<Record<string, unknown>>(sql, params);
    const hasMore = listed.rows.length > query.limit;
    const rows = hasMore ? listed.rows.slice(0, query.limit) : listed.rows;

    const nextCursor = hasMore
      ? encodeCursor({
          id: String(rows[rows.length - 1].id),
          sortValue: String(rows[rows.length - 1][sortColumn]),
        })
      : null;

    return response.status(200).json({
      data: rows,
      page_info: {
        next_cursor: nextCursor,
        has_more: hasMore,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/mine", requireAuth, validateQuery(bountyListQuerySchema), async (request, response, next) => {
  try {
    if (!request.user) {
      throw new AppError(401, 401, "Unauthorized");
    }

    const query = request.query as unknown as {
      status?: BountyStatus;
      language?: string;
      min_amount?: bigint;
      max_amount?: bigint;
      sort_by: "deadline" | "amount" | "created";
      sort_order: "asc" | "desc";
      limit: number;
      cursor?: string;
    };

    const sortColumn =
      query.sort_by === "deadline"
        ? "deadline"
        : query.sort_by === "amount"
          ? "total_amount"
          : "created_at";

    const params: unknown[] = [request.user.userId];
    const where: string[] = ["deleted_at IS NULL", "creator_id = $1"];

    if (query.status) {
      params.push(query.status);
      where.push(`status = $${params.length}`);
    }
    if (query.language) {
      params.push(query.language.toLowerCase());
      where.push(`LOWER($${params.length}) = ANY (SELECT LOWER(x) FROM unnest(allowed_languages) AS x)`);
    }
    if (query.min_amount !== undefined) {
      params.push(query.min_amount.toString());
      where.push(`total_amount >= $${params.length}::bigint`);
    }
    if (query.max_amount !== undefined) {
      params.push(query.max_amount.toString());
      where.push(`total_amount <= $${params.length}::bigint`);
    }

    const cursor = decodeCursor(query.cursor);
    if (cursor && cursor.sortValue) {
      params.push(cursor.sortValue, cursor.id);
      const op = query.sort_order === "asc" ? ">" : "<";
      where.push(`(${sortColumn}, id) ${op} ($${params.length - 1}, $${params.length})`);
    }

    params.push(query.limit + 1);

    const sql = `
      SELECT ${BOUNTY_SELECT_COLUMNS}
      FROM bounties
      WHERE ${where.join(" AND ")}
      ORDER BY ${sortColumn} ${query.sort_order.toUpperCase()}, id ${query.sort_order.toUpperCase()}
      LIMIT $${params.length}
    `;

    const listed = await dbQuery<Record<string, unknown>>(sql, params);
    const hasMore = listed.rows.length > query.limit;
    const rows = hasMore ? listed.rows.slice(0, query.limit) : listed.rows;

    const nextCursor = hasMore
      ? encodeCursor({
          id: String(rows[rows.length - 1].id),
          sortValue: String(rows[rows.length - 1][sortColumn]),
        })
      : null;

    return response.status(200).json({
      data: rows,
      page_info: {
        next_cursor: nextCursor,
        has_more: hasMore,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id/context", requireAuth, validateParams(idParamSchema), async (request, response, next) => {
  try {
    if (!request.user) {
      throw new AppError(401, 401, "Unauthorized");
    }

    const bounty = await getBountyById(request.params.id);
    if (!bounty) {
      throw new AppError(404, 404, "Bounty not found");
    }

    const creator = await dbQuery<{ id: string; wallet_address: string; email: string | null }>(
      `
        SELECT id, wallet_address, email
        FROM users
        WHERE id = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [bounty.creator_id],
    );

    const milestones = await dbQuery<{
      id: string;
      bounty_id: string;
      title: string;
      description: string;
      payout_amount: string;
      order_index: number;
      status: string;
      payout_tx_id: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `
        SELECT id,
               bounty_id,
               title,
               description,
               payout_amount::text,
               order_index,
               status::text AS status,
               payout_tx_id,
               created_at::text,
               updated_at::text
        FROM milestones
        WHERE bounty_id = $1
        ORDER BY order_index ASC
      `,
      [bounty.id],
    );

    const submissions = await dbQuery<{
      id: string;
      bounty_id: string;
      freelancer_id: string;
      github_pr_url: string;
      github_branch: string;
      ci_status: string;
      ci_run_id: string | null;
      ci_retrigger_count: number;
      skipped_test_count: number;
      total_test_count: number;
      ai_score: number | null;
      ai_score_raw: Record<string, unknown> | null;
      ai_integrity_flag: boolean;
      ai_language_mismatch_flag: boolean;
      final_score: number | null;
      status: string;
      score_finalized_at: string | null;
      client_flagged_at: string | null;
      submission_received_at: string;
      created_at: string;
      updated_at: string;
      freelancer_wallet_address: string;
      freelancer_email: string | null;
      payout_status: string | null;
      payout_tx_id: string | null;
      payout_hold_reason: string | null;
      dispute_id: string | null;
      dispute_status: string | null;
      dispute_raised_at: string | null;
    }>(
      `
        SELECT s.id,
               s.bounty_id,
               s.freelancer_id,
               s.github_pr_url,
               s.github_branch,
               s.ci_status::text AS ci_status,
               s.ci_run_id::text,
               COALESCE(s.ci_retrigger_count, 0) AS ci_retrigger_count,
               s.skipped_test_count,
               s.total_test_count,
               s.ai_score,
               s.ai_score_raw,
               s.ai_integrity_flag,
               s.ai_language_mismatch_flag,
               s.final_score,
               s.status::text AS status,
               s.score_finalized_at::text,
               s.client_flagged_at::text,
               s.submission_received_at::text,
               s.created_at::text,
               s.updated_at::text,
               u.wallet_address AS freelancer_wallet_address,
               u.email AS freelancer_email,
               p.status::text AS payout_status,
               p.tx_id AS payout_tx_id,
               p.hold_reason AS payout_hold_reason,
               d.id AS dispute_id,
               d.status::text AS dispute_status,
               d.raised_at::text AS dispute_raised_at
        FROM submissions s
        JOIN users u ON u.id = s.freelancer_id
        LEFT JOIN LATERAL (
          SELECT status, tx_id, hold_reason
          FROM payouts p
          WHERE p.submission_id = s.id
          ORDER BY p.created_at DESC
          LIMIT 1
        ) p ON TRUE
        LEFT JOIN LATERAL (
          SELECT id, status, raised_at
          FROM disputes d
          WHERE d.submission_id = s.id
          ORDER BY d.created_at DESC
          LIMIT 1
        ) d ON TRUE
        WHERE s.bounty_id = $1
        ORDER BY s.created_at DESC
      `,
      [bounty.id],
    );

    const submissionCount = submissions.rows.length;
    const isClientViewer = request.user.userId === bounty.creator_id || request.user.role === "admin";
    const isFreelancerViewer = request.user.role === "freelancer";

    const visibleSubmissions = isClientViewer
      ? submissions.rows
      : submissions.rows.filter((item) => item.freelancer_id === request.user?.userId);

    const activeSubmissionCount = submissions.rows.filter((item) =>
      ["submitted", "validating", "awaiting_ci", "in_progress", "passed", "disputed"].includes(item.status),
    ).length;

    const activity = buildBountyActivity({
      bounty,
      submissions: submissions.rows,
      milestones: milestones.rows,
    });

    return response.status(200).json({
      bounty,
      creator: creator.rows[0] ?? null,
      milestones: milestones.rows,
      submissions: visibleSubmissions,
      submissions_count: submissionCount,
      active_submission_count: activeSubmissionCount,
      viewer: {
        role: request.user.role,
        user_id: request.user.userId,
        is_client: isClientViewer,
        is_freelancer: isFreelancerViewer,
      },
      activity,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", validateParams(idParamSchema), async (request, response, next) => {
  try {
    const bounty = await getBountyById(request.params.id);
    if (!bounty) {
      return response.status(404).json({
        error: "Not found",
        code: 404,
        detail: "Bounty not found",
      });
    }

    return response.status(200).json({ bounty });
  } catch (error) {
    return next(error);
  }
});

router.patch(
  "/:id/extend-deadline",
  requireAuth,
  validateParams(idParamSchema),
  validateBody(extendDeadlineSchema),
  async (request, response, next) => {
    try {
      if (!request.user) {
        throw new AppError(401, 401, "Unauthorized");
      }

      const bounty = await getBountyById(request.params.id);
      if (!bounty) {
        throw new AppError(404, 404, "Bounty not found");
      }
      assertBountyIsActionable(bounty, "extend_deadline");
      if (bounty.creator_id !== request.user.userId || request.user.role !== "client") {
        throw new AppError(403, 403, "Only the bounty client creator can extend deadline");
      }
      if (bounty.extension_count >= 2) {
        throw new AppError(409, 409, "DL-C-004: Extension limit reached");
      }

      const ackSql = `
        SELECT id
        FROM bounty_deadline_acknowledgments
        WHERE bounty_id = $1
        LIMIT 1
      `;
      const ack = await dbQuery<{ id: string }>(ackSql, [bounty.id]);
      if ((ack.rowCount ?? 0) === 0) {
        throw new AppError(409, 409, "Freelancer acknowledgment is required before extension");
      }

      const newDeadline = request.body.deadline as Date;
      await algorand.extendBountyDeadline(bounty.id, newDeadline.toISOString());

      const updateSql = `
        UPDATE bounties
        SET deadline = $1,
            extension_count = extension_count + 1
        WHERE id = $2
          AND deleted_at IS NULL
        RETURNING ${BOUNTY_SELECT_COLUMNS}
      `;
      const updated = await dbQuery(updateSql, [newDeadline.toISOString(), bounty.id]);

      emitToBounty(bounty.id, "bounty:deadline_extended", {
        bounty_id: bounty.id,
        new_deadline: newDeadline.toISOString(),
      });

      return response.status(200).json({ bounty: updated.rows[0] });
    } catch (error) {
      return next(error);
    }
  },
);

router.patch(
  "/:id/raise-amount",
  requireAuth,
  sanctionsMiddleware("bounties.raise_amount"),
  validateParams(idParamSchema),
  validateBody(raiseBountyAmountSchema),
  async (request, response, next) => {
    try {
      if (!request.user) {
        throw new AppError(401, 401, "Unauthorized");
      }

      const bounty = await getBountyById(request.params.id);
      if (!bounty) {
        throw new AppError(404, 404, "Bounty not found");
      }

      assertBountyIsActionable(bounty, "raise_amount");
      if (bounty.creator_id !== request.user.userId || request.user.role !== "client") {
        throw new AppError(403, 403, "Only the bounty creator can raise amount");
      }

      const allowedStatuses = new Set(["draft", "open", "in_progress", "pending_escrow"]);
      if (!allowedStatuses.has(bounty.status)) {
        throw new AppError(409, 409, "Amount can only be raised for active bounties");
      }

      const nextAmount = request.body.new_total_amount as bigint;
      const currentAmount = BigInt(bounty.total_amount);
      if (nextAmount <= currentAmount) {
        throw new AppError(400, 400, "new_total_amount must be greater than current total_amount");
      }

      const delta = nextAmount - currentAmount;
      if (bounty.escrow_locked) {
        await algorand.assertWalletHasEscrowBalance(request.user.walletAddress, delta, 2_000n);
      }

      const updated = await dbQuery<BountyRow>(
        `
          UPDATE bounties
          SET total_amount = $1,
              updated_at = NOW()
          WHERE id = $2
            AND deleted_at IS NULL
          RETURNING ${BOUNTY_SELECT_COLUMNS}
        `,
        [nextAmount.toString(), bounty.id],
      );

      return response.status(200).json({
        bounty: updated.rows[0],
        delta_amount: delta.toString(),
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.delete(
  "/:id",
  requireAuth,
  sanctionsMiddleware("bounties.cancel"),
  validateParams(idParamSchema),
  async (request, response, next) => {
    try {
      if (!request.user) {
        throw new AppError(401, 401, "Unauthorized");
      }

      const bounty = await getBountyById(request.params.id);
      if (!bounty) {
        throw new AppError(404, 404, "Bounty not found");
      }
      assertBountyIsActionable(bounty, "cancel");
      if (bounty.creator_id !== request.user.userId) {
        throw new AppError(403, 403, "Only the creator can cancel the bounty");
      }
      if (bounty.status === "in_progress") {
        throw new AppError(409, 409, "SC-C-007: Cannot cancel bounty while it is in progress");
      }

      const activeSubmissionsSql = `
        SELECT id
        FROM submissions
        WHERE bounty_id = $1
          AND status IN ('submitted', 'validating', 'passed', 'disputed')
        LIMIT 1
      `;
      const activeSubmissions = await dbQuery<{ id: string }>(activeSubmissionsSql, [bounty.id]);
      if ((activeSubmissions.rowCount ?? 0) > 0) {
        throw new AppError(409, 409, "SC-C-007: Active submissions exist. Cancellation blocked.");
      }

      if (bounty.escrow_locked) {
        await algorand.refundClientEscrow(bounty.id);
      }

      const cancelSql = `
        UPDATE bounties
        SET status = 'cancelled',
            deleted_at = NOW()
        WHERE id = $1
          AND deleted_at IS NULL
        RETURNING ${BOUNTY_SELECT_COLUMNS}
      `;

      const cancelled = await dbQuery(cancelSql, [bounty.id]);
      return response.status(200).json({ bounty: cancelled.rows[0] });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/:id/accept",
  requireAuth,
  sanctionsMiddleware("bounties.accept"),
  validateParams(idParamSchema),
  validateBody(acceptBountySchema),
  async (request, response, next) => {
    try {
      if (!request.user) {
        throw new AppError(401, 401, "Unauthorized");
      }

      const bounty = await getBountyById(request.params.id);
      if (!bounty) {
        throw new AppError(404, 404, "Bounty not found");
      }
      assertBountyIsActionable(bounty, "accept");
      if (bounty.creator_id === request.user.userId) {
        throw new AppError(403, 403, "XC-001: Creator cannot accept own bounty");
      }
      if (bounty.max_freelancers === 1 && bounty.status === "in_progress") {
        throw new AppError(409, 409, "SC-C-007: This bounty is taken");
      }
      if (!["open", "in_progress"].includes(bounty.status)) {
        throw new AppError(409, 409, "Bounty is not accepting freelancers right now");
      }

      const submission = await acceptBountyWithRowLock({
        bountyId: bounty.id,
        freelancerId: request.user.userId,
        githubPrUrl: request.body.github_pr_url,
        githubBranch: request.body.github_branch,
        githubRepoId: request.body.github_repo_id.toString(),
        scoringIdempotencyKey: createScoringIdempotencyKey(
          request.user.walletAddress,
          bounty.id,
          request.body.github_pr_url,
        ),
      });

      emitToBounty(bounty.id, "bounty:accepted", {
        bounty_id: bounty.id,
        submission_id: submission.id,
        freelancer_id: request.user.userId,
      });

      emitToUser(bounty.creator_id, "bounty:accepted", {
        bounty_id: bounty.id,
        submission_id: submission.id,
        freelancer_id: request.user.userId,
      });

      return response.status(201).json({ submission });
    } catch (error) {
      return next(error);
    }
  },
);

function createBountyIdempotencyKey(wallet: string, title: string) {
  const bucket = Math.floor(Date.now() / 1000 / 300);
  const raw = `${wallet}|${title.trim().toLowerCase()}|${bucket}`;
  return createHash("sha256").update(raw).digest("hex");
}

function createScoringIdempotencyKey(wallet: string, bountyId: string, prUrl: string) {
  const raw = `${wallet}|${bountyId}|${prUrl}|${randomUUID()}`;
  return createHash("sha256").update(raw).digest("hex");
}

async function getBountyById(id: string) {
  const sql = `
    SELECT ${BOUNTY_SELECT_COLUMNS}
    FROM bounties
    WHERE id = $1
      AND deleted_at IS NULL
    LIMIT 1
  `;
  const result = await dbQuery<BountyRow>(sql, [id]);
  return result.rows[0] ?? null;
}

function assertBountyIsActionable(bounty: BountyRow, action: string) {
  if (bounty.status === "error_escrow_corrupt") {
    throw new AppError(409, 409, `DB-004: bounty action blocked (${action}) due to escrow corruption`);
  }
}

async function getBountyByIdempotencyKey(idempotencyKey: string) {
  const sql = `
    SELECT ${BOUNTY_SELECT_COLUMNS}
    FROM bounties
    WHERE idempotency_key = $1
      AND deleted_at IS NULL
    LIMIT 1
  `;
  const result = await dbQuery<BountyRow>(sql, [idempotencyKey]);
  return result.rows[0] ?? null;
}

async function verifyGitHubAppInstalled(owner: string, repo: string) {
  const strictGitHubChecks =
    process.env.GITHUB_VERIFY_STRICT === "true" && process.env.HACKATHON_MODE !== "true";
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    if (!strictGitHubChecks || process.env.NODE_ENV !== "production") {
      return true;
    }
    throw new AppError(400, 400, "GH-C-001: GITHUB_TOKEN is required for repository verification");
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "BountyEscrow-AI",
      },
    });

    if (!response.ok && (!strictGitHubChecks || process.env.NODE_ENV !== "production")) {
      return true;
    }

    return response.ok;
  } catch {
    if (!strictGitHubChecks || process.env.NODE_ENV !== "production") {
      return true;
    }
    return false;
  }
}

async function checkGitHubActionsWorkflows(owner: string, repo: string) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return false;
  }

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "BountyEscrow-AI",
    },
  });

  if (!response.ok) {
    return false;
  }

  const payload = (await response.json()) as { total_count?: number };
  return Number(payload.total_count ?? 0) > 0;
}

function encodeCursor(input: { id: string; sortValue: string }) {
  return Buffer.from(JSON.stringify(input)).toString("base64url");
}

function decodeCursor(cursor?: string) {
  if (!cursor) {
    return null;
  }

  try {
    const payload = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(payload) as { id?: string; sortValue?: string };
    if (!parsed.id || !parsed.sortValue) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function buildBountyActivity(input: {
  bounty: BountyRow;
  submissions: Array<{
    id: string;
    status: string;
    ci_status: string;
    ai_score: number | null;
    payout_status: string | null;
    dispute_id: string | null;
    created_at: string;
    updated_at: string;
  }>;
  milestones: Array<{ id: string; status: string; updated_at: string; order_index: number }>;
}) {
  const events: Array<{ key: string; label: string; at: string; detail?: string }> = [];

  events.push({
    key: `created:${input.bounty.id}`,
    label: "Bounty Created",
    at: input.bounty.created_at.toISOString(),
  });

  if (input.bounty.escrow_locked) {
    events.push({
      key: `funded:${input.bounty.id}`,
      label: "Bounty Funded",
      at: input.bounty.updated_at.toISOString(),
    });
  }

  for (const submission of input.submissions) {
    events.push({
      key: `accepted:${submission.id}`,
      label: "Freelancer Accepted",
      at: submission.created_at,
    });
    events.push({
      key: `submitted:${submission.id}`,
      label: "Work Submitted",
      at: submission.created_at,
    });

    if (submission.ci_status === "passed") {
      events.push({
        key: `ci-pass:${submission.id}`,
        label: "CI Passed",
        at: submission.updated_at,
      });
    }
    if (["failed", "timeout", "skipped_abuse"].includes(submission.ci_status)) {
      events.push({
        key: `ci-fail:${submission.id}`,
        label: "CI Failed",
        at: submission.updated_at,
        detail: submission.ci_status,
      });
    }
    if (submission.ai_score !== null) {
      events.push({
        key: `ai-score:${submission.id}`,
        label: "AI Scored",
        at: submission.updated_at,
      });
    }
    if (submission.payout_status === "completed") {
      events.push({
        key: `payout:${submission.id}`,
        label: "Payout Released",
        at: submission.updated_at,
      });
    }
    if (submission.dispute_id) {
      events.push({
        key: `dispute:${submission.id}`,
        label: "Bounty Disputed",
        at: submission.updated_at,
      });
    }
  }

  for (const milestone of input.milestones) {
    if (milestone.status === "paid") {
      events.push({
        key: `milestone-paid:${milestone.id}`,
        label: `Milestone ${milestone.order_index + 1} Paid`,
        at: milestone.updated_at,
      });
    }
  }

  return events
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 100);
}

// Assign a freelancer to a bounty from a project application
router.post(
  "/:id/assign",
  requireAuth,
  validateParams(idParamSchema),
  validateBody(z.object({ applicationId: z.string().uuid() })),
  async (request, response, next) => {
    try {
      const user = requireUser(request);
      const bountyId = request.params.id;
      const { applicationId } = request.body as { applicationId: string };

      const bounty = await dbQuery<{
        creator_id: string;
        status: string;
        repo_url: string;
        target_branch: string;
      }>(
        `
          SELECT creator_id, status, repo_url, target_branch
          FROM bounties
          WHERE id = $1
            AND deleted_at IS NULL
        `,
        [bountyId],
      );

      if ((bounty.rowCount ?? 0) === 0) {
        throw new AppError(404, 404, "Bounty not found");
      }

      if (bounty.rows[0].creator_id !== user.userId) {
        throw new AppError(403, 403, "Only bounty creator can assign freelancers");
      }

      if (bounty.rows[0].status !== "open") {
        throw new AppError(409, 409, "Bounty must be open to assign freelancers");
      }

      const application = await dbQuery<{
        id: string;
        freelancer_id: string;
        bounty_id: string;
        status: string;
      }>(
        `
          SELECT id, freelancer_id, bounty_id, status
          FROM project_applications
          WHERE id = $1
          LIMIT 1
        `,
        [applicationId],
      );

      if ((application.rowCount ?? 0) === 0) {
        throw new AppError(404, 404, "Application not found");
      }

      if (application.rows[0].bounty_id !== bountyId) {
        throw new AppError(400, 400, "Application does not belong to this bounty");
      }

      const freelancerId = application.rows[0].freelancer_id;
      const bountyRow = bounty.rows[0];

      await dbQuery(
        `
          UPDATE project_applications
          SET status = CASE WHEN id = $1 THEN 'selected' ELSE 'rejected' END,
              updated_at = NOW()
          WHERE bounty_id = $2
        `,
        [applicationId, bountyId],
      );

      await dbQuery(
        `UPDATE bounties SET status = 'in_progress', updated_at = NOW() WHERE id = $1`,
        [bountyId],
      );

      const existingSubmission = await dbQuery<{ id: string }>(
        `
          SELECT id
          FROM submissions
          WHERE bounty_id = $1
            AND freelancer_id = $2
          ORDER BY updated_at DESC
          LIMIT 1
        `,
        [bountyId, freelancerId],
      );

      let submissionId = existingSubmission.rows[0]?.id ?? null;
      if (!submissionId) {
        submissionId = randomUUID();
        const scoringIdempotencyKey = createHash("sha256")
          .update(`${bountyId}:${freelancerId}:${submissionId}`)
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
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              0,
              'draft',
              'draft',
              'none',
              NOW() + INTERVAL '7 days',
              $6,
              NOW()
            )
          `,
          [
            submissionId,
            bountyId,
            freelancerId,
            `${bountyRow.repo_url}/pull/0`,
            bountyRow.target_branch,
            scoringIdempotencyKey,
          ],
        );
      }

      emitToBounty(bountyId, "bounty:accepted", {
        bounty_id: bountyId,
        submission_id: submissionId,
        freelancer_id: freelancerId,
      });

      emitToUser(freelancerId, "bounty:accepted", {
        bounty_id: bountyId,
        submission_id: submissionId,
        freelancer_id: freelancerId,
      });

      return response.status(200).json({
        assigned: true,
        submissionId,
        message: "Freelancer assigned successfully",
      });
    } catch (error) {
      return next(error);
    }
  },
);

export default router;
