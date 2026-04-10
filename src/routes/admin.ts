import { Router } from "express";
import { z } from "zod";
import { dbQuery } from "../../lib/db/client";
import { inngest } from "../jobs/aiScoring.job";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { validateBody, validateParams, validateQuery } from "../middleware/validate";

const router = Router();

const idParamSchema = z.object({
  id: z.string().uuid(),
});

const deadLetterIdSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const bountiesQuerySchema = z.object({
  status: z.string().trim().max(40).optional(),
  creator: z.string().trim().max(120).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

const usersQuerySchema = z.object({
  query: z.string().trim().max(120).optional(),
  role: z.enum(["client", "freelancer", "arbitrator", "admin"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const disputesQuerySchema = z.object({
  status: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const deadLettersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const overrideScoringSchema = z.object({
  submission_id: z.string().uuid(),
  final_score: z.coerce.number().min(0).max(100),
  reason: z.string().trim().min(10).max(2000),
});

const manualResolveSchema = z.object({
  outcome: z.enum(["freelancer_wins", "client_wins", "split"]),
  freelancer_share_percent: z.coerce.number().min(0).max(100).optional(),
  justification: z.string().trim().min(10).max(2000),
});

const changeRoleSchema = z.object({
  role: z.enum(["client", "freelancer", "arbitrator", "admin"]),
});

function requireAdmin(request: Parameters<typeof requireAuth>[0]) {
  if (!request.user) {
    throw new AppError(401, 401, "Unauthorized");
  }

  if (request.user.role !== "admin") {
    throw new AppError(403, 403, "Admin role required");
  }

  return request.user;
}

router.get("/admin/overview", requireAuth, async (request, response, next) => {
  try {
    requireAdmin(request);

    const [stats, consistency] = await Promise.all([
      dbQuery<{
        total_bounties: number;
        total_algo_locked: string;
        active_disputes: number;
        flagged_submissions: number;
        sanctions_flags: number;
        dead_letter_jobs_count: number;
      }>(
        `
          SELECT
            (SELECT COUNT(*)::int FROM bounties WHERE deleted_at IS NULL) AS total_bounties,
            (
              SELECT COALESCE(SUM(total_amount), 0)::text
              FROM bounties
              WHERE deleted_at IS NULL
                AND escrow_locked = TRUE
                AND status NOT IN ('cancelled', 'expired', 'expired_no_submission', 'expired_all_failed')
            ) AS total_algo_locked,
            (
              SELECT COUNT(*)::int
              FROM disputes
              WHERE status IN ('under_review', 'escalated')
            ) AS active_disputes,
            (
              SELECT COUNT(*)::int
              FROM submissions
              WHERE ai_integrity_flag = TRUE
                 OR ai_language_mismatch_flag = TRUE
                 OR client_flagged_at IS NOT NULL
            ) AS flagged_submissions,
            (
              SELECT COUNT(*)::int
              FROM users
              WHERE is_sanctions_flagged = TRUE
                AND deleted_at IS NULL
            ) AS sanctions_flags,
            (
              SELECT COUNT(*)::int
              FROM dead_letter_jobs
            ) AS dead_letter_jobs_count
        `,
      ),
      dbQuery<{
        issue_type: string;
        issue_count: number;
      }>(
        `
          SELECT 'escrow_without_contract' AS issue_type, COUNT(*)::int AS issue_count
          FROM bounties
          WHERE deleted_at IS NULL
            AND escrow_locked = TRUE
            AND escrow_contract_address IS NULL

          UNION ALL

          SELECT 'orphaned_payouts' AS issue_type, COUNT(*)::int AS issue_count
          FROM payouts p
          JOIN submissions s ON s.id = p.submission_id
          JOIN bounties b ON b.id = s.bounty_id
          WHERE p.status = 'processing'
            AND p.updated_at < NOW() - INTERVAL '1 hour'
            AND b.deleted_at IS NULL

          UNION ALL

          SELECT 'stuck_submissions' AS issue_type, COUNT(*)::int AS issue_count
          FROM submissions s
          JOIN bounties b ON b.id = s.bounty_id
          WHERE s.status = 'validating'
            AND s.updated_at < NOW() - INTERVAL '2 hours'
            AND b.deleted_at IS NULL
        `,
      ),
    ]);

    return response.status(200).json({
      stats: stats.rows[0],
      consistency: consistency.rows,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/admin/consistency-alerts", requireAuth, async (request, response, next) => {
  try {
    requireAdmin(request);

    const [escrow, orphaned, stuck] = await Promise.all([
      dbQuery<{
        id: string;
        title: string;
        created_at: string;
      }>(
        `
          SELECT id,
                 title,
                 created_at::text
          FROM bounties
          WHERE deleted_at IS NULL
            AND escrow_locked = TRUE
            AND escrow_contract_address IS NULL
          ORDER BY created_at DESC
          LIMIT 50
        `,
      ),
      dbQuery<{
        payout_id: string;
        submission_id: string;
        bounty_id: string;
        updated_at: string;
      }>(
        `
          SELECT p.id AS payout_id,
                 p.submission_id,
                 s.bounty_id,
                 p.updated_at::text
          FROM payouts p
          JOIN submissions s ON s.id = p.submission_id
          JOIN bounties b ON b.id = s.bounty_id
          WHERE p.status = 'processing'
            AND p.updated_at < NOW() - INTERVAL '1 hour'
            AND b.deleted_at IS NULL
          ORDER BY p.updated_at ASC
          LIMIT 50
        `,
      ),
      dbQuery<{
        submission_id: string;
        bounty_id: string;
        updated_at: string;
      }>(
        `
          SELECT s.id AS submission_id,
                 s.bounty_id,
                 s.updated_at::text
          FROM submissions s
          JOIN bounties b ON b.id = s.bounty_id
          WHERE s.status = 'validating'
            AND s.updated_at < NOW() - INTERVAL '2 hours'
            AND b.deleted_at IS NULL
          ORDER BY s.updated_at ASC
          LIMIT 50
        `,
      ),
    ]);

    const issues = [
      ...escrow.rows.map((row) => ({
        id: `escrow-${row.id}`,
        type: "Escrow locked without contract address",
        reference: row.id,
        occurred_at: row.created_at,
      })),
      ...orphaned.rows.map((row) => ({
        id: `orphan-${row.payout_id}`,
        type: "Orphaned payouts",
        reference: row.payout_id,
        occurred_at: row.updated_at,
      })),
      ...stuck.rows.map((row) => ({
        id: `stuck-${row.submission_id}`,
        type: "Stuck submissions (> 2 hours)",
        reference: row.submission_id,
        occurred_at: row.updated_at,
      })),
    ];

    issues.sort((left, right) => new Date(right.occurred_at).getTime() - new Date(left.occurred_at).getTime());

    return response.status(200).json({ data: issues });
  } catch (error) {
    return next(error);
  }
});

router.get("/admin/bounties", requireAuth, validateQuery(bountiesQuerySchema), async (request, response, next) => {
  try {
    requireAdmin(request);

    const query = request.query as unknown as {
      status?: string;
      creator?: string;
      from?: string;
      to?: string;
      limit: number;
    };

    const params: Array<string | number> = [];
    const where: string[] = ["b.deleted_at IS NULL"];

    if (query.status) {
      params.push(query.status);
      where.push(`b.status::text = $${params.length}`);
    }

    if (query.creator) {
      params.push(`%${query.creator.toLowerCase()}%`);
      where.push(`(
        LOWER(COALESCE(u.wallet_address, '')) LIKE $${params.length}
        OR LOWER(COALESCE(u.email, '')) LIKE $${params.length}
      )`);
    }

    if (query.from) {
      params.push(query.from);
      where.push(`b.created_at >= $${params.length}::timestamptz`);
    }

    if (query.to) {
      params.push(query.to);
      where.push(`b.created_at <= $${params.length}::timestamptz`);
    }

    params.push(query.limit);

    const rows = await dbQuery<{
      id: string;
      title: string;
      status: string;
      total_amount: string;
      creator_wallet: string;
      creator_email: string | null;
      deadline: string;
      created_at: string;
      updated_at: string;
    }>(
      `
        SELECT b.id,
               b.title,
               b.status::text AS status,
               b.total_amount::text,
               u.wallet_address AS creator_wallet,
               u.email AS creator_email,
               b.deadline::text,
               b.created_at::text,
               b.updated_at::text
        FROM bounties b
        JOIN users u ON u.id = b.creator_id
        WHERE ${where.join(" AND ")}
        ORDER BY b.updated_at DESC
        LIMIT $${params.length}
      `,
      params,
    );

    return response.status(200).json({ data: rows.rows });
  } catch (error) {
    return next(error);
  }
});

router.post("/admin/bounties/:id/force-expire", requireAuth, validateParams(idParamSchema), async (request, response, next) => {
  try {
    requireAdmin(request);

    await dbQuery(
      `
        UPDATE bounties
        SET status = 'expired',
            updated_at = NOW()
        WHERE id = $1
          AND deleted_at IS NULL
      `,
      [request.params.id],
    );

    return response.status(200).json({ expired: true });
  } catch (error) {
    return next(error);
  }
});

router.post("/admin/bounties/:id/force-refund", requireAuth, validateParams(idParamSchema), async (request, response, next) => {
  try {
    requireAdmin(request);

    await dbQuery(
      `
        UPDATE bounties
        SET status = 'cancelled',
            updated_at = NOW()
        WHERE id = $1
          AND deleted_at IS NULL
      `,
      [request.params.id],
    );

    return response.status(200).json({ refunded: true });
  } catch (error) {
    return next(error);
  }
});

router.post(
  "/admin/bounties/:id/override-scoring",
  requireAuth,
  validateParams(idParamSchema),
  validateBody(overrideScoringSchema),
  async (request, response, next) => {
    try {
      requireAdmin(request);

      const body = request.body as z.infer<typeof overrideScoringSchema>;
      const score = Math.round(body.final_score);

      await dbQuery(
        `
          UPDATE submissions
          SET final_score = $2,
              status = CASE WHEN $2 >= 70 THEN 'passed' ELSE 'failed' END,
              score_finalized_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
            AND bounty_id = $3
        `,
        [body.submission_id, score, request.params.id],
      );

      return response.status(200).json({
        overridden: true,
        final_score: score,
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post("/admin/bounties/:id/cancel", requireAuth, validateParams(idParamSchema), async (request, response, next) => {
  try {
    requireAdmin(request);

    await dbQuery(
      `
        UPDATE bounties
        SET status = 'cancelled',
            updated_at = NOW()
        WHERE id = $1
          AND deleted_at IS NULL
      `,
      [request.params.id],
    );

    return response.status(200).json({ cancelled: true });
  } catch (error) {
    return next(error);
  }
});

router.get("/admin/users", requireAuth, validateQuery(usersQuerySchema), async (request, response, next) => {
  try {
    requireAdmin(request);

    const query = request.query as unknown as {
      query?: string;
      role?: "client" | "freelancer" | "arbitrator" | "admin";
      limit: number;
    };

    const params: Array<string | number> = [];
    const where: string[] = ["u.deleted_at IS NULL"];

    if (query.query) {
      params.push(`%${query.query.toLowerCase()}%`);
      where.push(`(
        LOWER(COALESCE(u.wallet_address, '')) LIKE $${params.length}
        OR LOWER(COALESCE(u.email, '')) LIKE $${params.length}
      )`);
    }

    if (query.role) {
      params.push(query.role);
      where.push(`u.role = $${params.length}`);
    }

    params.push(query.limit);

    const users = await dbQuery<{
      id: string;
      wallet_address: string;
      email: string | null;
      role: string;
      reputation_score: number;
      is_sanctions_flagged: boolean;
      is_banned: boolean;
      created_at: string;
    }>(
      `
        SELECT u.id,
               u.wallet_address,
               u.email,
               u.role::text AS role,
               u.reputation_score,
               u.is_sanctions_flagged,
               u.is_banned,
               u.created_at::text AS created_at
        FROM users u
        WHERE ${where.join(" AND ")}
        ORDER BY u.created_at DESC
        LIMIT $${params.length}
      `,
      params,
    );

    return response.status(200).json({ data: users.rows });
  } catch (error) {
    return next(error);
  }
});

router.post(
  "/admin/users/:id/remove-ban",
  requireAuth,
  validateParams(idParamSchema),
  async (request, response, next) => {
    try {
      requireAdmin(request);

      const userRow = await dbQuery<{ wallet_address: string }>(
        "SELECT wallet_address FROM users WHERE id = $1 LIMIT 1",
        [request.params.id],
      );

      if ((userRow.rowCount ?? 0) === 0) {
        throw new AppError(404, 404, "User not found");
      }

      await dbQuery("UPDATE users SET is_banned = FALSE, updated_at = NOW() WHERE id = $1", [request.params.id]);
      await dbQuery("DELETE FROM banned_wallets WHERE wallet_address = $1", [userRow.rows[0].wallet_address]);

      return response.status(200).json({ removed: true });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/admin/users/:id/change-role",
  requireAuth,
  validateParams(idParamSchema),
  validateBody(changeRoleSchema),
  async (request, response, next) => {
    try {
      requireAdmin(request);

      const role = (request.body as z.infer<typeof changeRoleSchema>).role;
      await dbQuery("UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1", [request.params.id, role]);

      return response.status(200).json({ changed: true, role });
    } catch (error) {
      return next(error);
    }
  },
);

router.get("/admin/disputes", requireAuth, validateQuery(disputesQuerySchema), async (request, response, next) => {
  try {
    requireAdmin(request);

    const query = request.query as unknown as {
      status?: string;
      limit: number;
    };

    const params: Array<string | number> = [];
    const where: string[] = [];

    if (query.status) {
      params.push(query.status);
      where.push(`d.status::text = $${params.length}`);
    }

    params.push(query.limit);

    const disputes = await dbQuery<{
      id: string;
      bounty_id: string;
      bounty_title: string;
      dispute_type: string;
      status: string;
      raised_at: string;
      sla_days: number;
    }>(
      `
        SELECT d.id,
               s.bounty_id,
               b.title AS bounty_title,
               d.dispute_type::text AS dispute_type,
               d.status::text AS status,
               d.raised_at::text AS raised_at,
               CASE
                 WHEN d.status = 'under_review' AND d.raised_at < NOW() - INTERVAL '7 days'
                   THEN EXTRACT(DAY FROM NOW() - d.raised_at)::int
                 ELSE 0
               END AS sla_days
        FROM disputes d
        JOIN submissions s ON s.id = d.submission_id
        JOIN bounties b ON b.id = s.bounty_id
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY d.raised_at DESC
        LIMIT $${params.length}
      `,
      params,
    );

    return response.status(200).json({ data: disputes.rows });
  } catch (error) {
    return next(error);
  }
});

router.post(
  "/admin/disputes/:id/manual-resolve",
  requireAuth,
  validateParams(idParamSchema),
  validateBody(manualResolveSchema),
  async (request, response, next) => {
    try {
      requireAdmin(request);

      const body = request.body as z.infer<typeof manualResolveSchema>;
      const splitPercent = Math.max(0, Math.min(100, Math.round(body.freelancer_share_percent ?? 50)));

      await dbQuery(
        `
          UPDATE disputes
          SET status = 'resolved',
              outcome = $2,
              settlement_payload = $3::jsonb,
              resolved_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
        `,
        [
          request.params.id,
          body.outcome,
          JSON.stringify({
            manual_override: true,
            justification: body.justification,
            freelancer_share_percent: body.outcome === "split" ? splitPercent : body.outcome === "freelancer_wins" ? 100 : 0,
          }),
        ],
      );

      return response.status(200).json({ resolved: true });
    } catch (error) {
      return next(error);
    }
  },
);

router.get("/admin/dead-letters", requireAuth, validateQuery(deadLettersQuerySchema), async (request, response, next) => {
  try {
    requireAdmin(request);

    const query = request.query as unknown as { limit: number };

    const rows = await dbQuery<{
      id: number;
      event_name: string;
      payload: Record<string, unknown>;
      error: string;
      job_name: string | null;
      failed_at: string;
    }>(
      `
        SELECT id,
               event_name,
               payload,
               error,
               job_name,
               failed_at::text AS failed_at
        FROM dead_letter_jobs
        ORDER BY failed_at DESC
        LIMIT $1
      `,
      [query.limit],
    );

    return response.status(200).json({ data: rows.rows });
  } catch (error) {
    return next(error);
  }
});

router.post(
  "/admin/dead-letters/:id/retry",
  requireAuth,
  validateParams(deadLetterIdSchema),
  async (request, response, next) => {
    try {
      requireAdmin(request);

      const deadLetter = await dbQuery<{
        id: number;
        event_name: string;
        payload: Record<string, unknown>;
      }>(
        `
          SELECT id,
                 event_name,
                 payload
          FROM dead_letter_jobs
          WHERE id = $1
          LIMIT 1
        `,
        [request.params.id],
      );

      if ((deadLetter.rowCount ?? 0) === 0) {
        throw new AppError(404, 404, "Dead letter job not found");
      }

      await inngest.send({
        name: deadLetter.rows[0].event_name,
        data: deadLetter.rows[0].payload,
      });

      await dbQuery("DELETE FROM dead_letter_jobs WHERE id = $1", [request.params.id]);

      return response.status(200).json({ retried: true });
    } catch (error) {
      return next(error);
    }
  },
);

export default router;
