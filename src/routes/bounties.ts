import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
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
} from "../schemas/bounty.schema";
import { AlgorandService } from "../services/algorand";
import { parseGitHubRepo } from "../services/wallet";

const router = Router();
const algorand = new AlgorandService();

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
    const hasWorkflows = await checkGitHubActionsWorkflows(repoInfo.owner, repoInfo.repo);
    if (!hasWorkflows) {
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
      if (bounty.creator_id !== request.user.userId) {
        throw new AppError(403, 403, "Only the bounty creator can fund escrow");
      }
      if (bounty.status !== "draft") {
        throw new AppError(409, 409, "Bounty must be in draft status before funding");
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
    const where: string[] = ["deleted_at IS NULL"];

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

      const io = request.app.get("io") as { emit?: (event: string, payload: unknown) => void } | undefined;
      io?.emit?.("bounty:deadline_extended", {
        bounty_id: bounty.id,
        new_deadline: newDeadline.toISOString(),
      });

      return response.status(200).json({ bounty: updated.rows[0] });
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
      if (bounty.creator_id === request.user.userId) {
        throw new AppError(403, 403, "XC-001: Creator cannot accept own bounty");
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
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new AppError(400, 400, "GH-C-001: GITHUB_TOKEN is required for repository verification");
  }

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "BountyEscrow-AI",
    },
  });

  return response.ok;
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

export default router;
