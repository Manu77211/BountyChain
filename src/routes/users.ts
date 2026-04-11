import { Router } from "express";
import { z } from "zod";
import { dbQuery } from "../../lib/db/client";
import { requireAuth } from "../middleware/auth";
import { validateBody, validateParams, validateQuery } from "../middleware/validate";
import { isValidAlgorandAddress, normalizeWalletAddress } from "../services/wallet";
import { AlgorandService, type WalletTransactionView } from "../services/algorand";

const router = Router();
const algorandService = new AlgorandService();
const HACKATHON_MODE = process.env.HACKATHON_MODE === "true";
const ALGOD_MOCK_MODE = (process.env.ALGOD_MOCK_MODE ?? "true").toLowerCase() === "true";
const ALGORAND_NETWORK = (
  process.env.NEXT_PUBLIC_ALGORAND_NETWORK ?? process.env.ALGORAND_NETWORK ?? "testnet"
).toLowerCase();

function isDbConnectionError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "").toUpperCase()
    : "";

  return (
    message.includes("database") ||
    message.includes("enotfound") ||
    message.includes("econnrefused") ||
    message.includes("timed out") ||
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT"
  );
}

const updateProfileSchema = z.object({
  email: z.string().email().optional(),
  wallet_address: z.string().optional(),
});

const mockWalletBalanceSchema = z.object({
  amount_algo: z.coerce.number().min(0).max(1_000_000),
});

async function loadMockWalletBalanceMicroAlgo(userId: string) {
  try {
    const result = await dbQuery<{ balance_microalgo: string }>(
      `
        SELECT balance_microalgo::text AS balance_microalgo
        FROM mock_wallet_balances
        WHERE user_id = $1
        LIMIT 1
      `,
      [userId],
    );

    if ((result.rowCount ?? 0) === 0) {
      return null;
    }

    return BigInt(result.rows[0]?.balance_microalgo ?? "0");
  } catch {
    return null;
  }
}

const userIdParamsSchema = z.object({
  id: z.string().uuid("id must be a UUID"),
});

const activityQuerySchema = z.object({
  type: z.enum(["bounties", "submissions", "payouts", "disputes"]),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(50).default(10),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const payoutsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(50).default(10),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const walletTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

const discoverUsersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  role: z.enum(["all", "client", "freelancer"]).default("all"),
  limit: z.coerce.number().int().min(1).max(80).default(40),
});

router.get("/discover", validateQuery(discoverUsersQuerySchema), async (request, response, next) => {
  try {
    const query = request.query as unknown as {
      q?: string;
      role: "all" | "client" | "freelancer";
      limit: number;
    };

    const params: Array<string | number> = [];
    const filters: string[] = ["u.deleted_at IS NULL", "u.is_banned = FALSE"];

    if (query.role === "all") {
      filters.push("u.role IN ('client', 'freelancer')");
    }

    if (query.role !== "all") {
      params.push(query.role);
      filters.push(`u.role::text = $${params.length}`);
    }

    if (query.q) {
      params.push(`%${query.q.toLowerCase()}%`);
      const placeholder = `$${params.length}`;
      filters.push(`(
        LOWER(COALESCE(u.display_name, '')) LIKE ${placeholder}
        OR LOWER(COALESCE(u.email, '')) LIKE ${placeholder}
        OR LOWER(COALESCE(u.wallet_address, '')) LIKE ${placeholder}
      )`);
    }

    params.push(query.limit);

    const users = await dbQuery<{
      id: string;
      name: string;
      role: string;
      reputation_score: number;
      wallet_address: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `
        SELECT u.id,
               COALESCE(NULLIF(u.display_name, ''), NULLIF(u.email, ''), CONCAT('User ', LEFT(u.wallet_address, 8))) AS name,
               u.role::text AS role,
               u.reputation_score,
               u.wallet_address,
               u.created_at::text,
               u.updated_at::text
        FROM users u
        WHERE ${filters.join(" AND ")}
        ORDER BY u.reputation_score DESC, u.updated_at DESC
        LIMIT $${params.length}
      `,
      params,
    );

    if ((users.rowCount ?? 0) === 0) {
      return response.status(200).json({ data: [] });
    }

    const userIds = users.rows.map((row) => row.id);

    const completedCounts = await dbQuery<{ user_id: string; completed_count: number }>(
      `
        SELECT grouped.user_id,
               SUM(grouped.completed_count)::int AS completed_count
        FROM (
          SELECT b.creator_id AS user_id,
                 COUNT(*)::int AS completed_count
          FROM bounties b
          WHERE b.creator_id = ANY($1::uuid[])
            AND b.status = 'completed'
            AND b.deleted_at IS NULL
          GROUP BY b.creator_id

          UNION ALL

          SELECT s.freelancer_id AS user_id,
                 COUNT(*)::int AS completed_count
          FROM submissions s
          JOIN bounties b ON b.id = s.bounty_id
          WHERE s.freelancer_id = ANY($1::uuid[])
            AND s.status = 'passed'
            AND b.deleted_at IS NULL
          GROUP BY s.freelancer_id
        ) grouped
        GROUP BY grouped.user_id
      `,
      [userIds],
    );

    const completedByUser = new Map(completedCounts.rows.map((row) => [row.user_id, row.completed_count]));

    const completedItems = await dbQuery<{
      user_id: string;
      bounty_id: string;
      title: string;
      completed_at: string;
    }>(
      `
        SELECT entry.user_id,
               entry.bounty_id,
               entry.title,
               entry.completed_at::text
        FROM (
          SELECT b.creator_id AS user_id,
                 b.id AS bounty_id,
                 b.title,
                 b.updated_at AS completed_at
          FROM bounties b
          WHERE b.creator_id = ANY($1::uuid[])
            AND b.status = 'completed'
            AND b.deleted_at IS NULL

          UNION ALL

          SELECT s.freelancer_id AS user_id,
                 b.id AS bounty_id,
                 b.title,
                 COALESCE(s.score_finalized_at, s.updated_at) AS completed_at
          FROM submissions s
          JOIN bounties b ON b.id = s.bounty_id
          WHERE s.freelancer_id = ANY($1::uuid[])
            AND s.status = 'passed'
            AND b.deleted_at IS NULL
        ) entry
        ORDER BY entry.completed_at DESC
      `,
      [userIds],
    );

    const completedListByUser = new Map<
      string,
      Array<{ id: string; title: string; completedAt: string }>
    >();

    for (const row of completedItems.rows) {
      const current = completedListByUser.get(row.user_id) ?? [];
      if (current.length >= 4) {
        continue;
      }

      current.push({
        id: row.bounty_id,
        title: row.title,
        completedAt: row.completed_at,
      });
      completedListByUser.set(row.user_id, current);
    }

    const stories = await dbQuery<{ user_id: string; story: string; happened_at: string }>(
      `
        SELECT stories.user_id,
               stories.story,
               stories.happened_at::text
        FROM (
          SELECT b.creator_id AS user_id,
                 CONCAT('Posted bounty: ', b.title) AS story,
                 b.created_at AS happened_at
          FROM bounties b
          WHERE b.creator_id = ANY($1::uuid[])
            AND b.deleted_at IS NULL

          UNION ALL

          SELECT b.creator_id AS user_id,
                 CONCAT('Completed bounty: ', b.title) AS story,
                 b.updated_at AS happened_at
          FROM bounties b
          WHERE b.creator_id = ANY($1::uuid[])
            AND b.status = 'completed'
            AND b.deleted_at IS NULL

          UNION ALL

          SELECT s.freelancer_id AS user_id,
                 CONCAT('Completed delivery: ', b.title) AS story,
                 COALESCE(s.score_finalized_at, s.updated_at) AS happened_at
          FROM submissions s
          JOIN bounties b ON b.id = s.bounty_id
          WHERE s.freelancer_id = ANY($1::uuid[])
            AND s.status = 'passed'
            AND b.deleted_at IS NULL

          UNION ALL

          SELECT s.freelancer_id AS user_id,
                 CONCAT('Dispute resolved: ', b.title) AS story,
                 d.resolved_at AS happened_at
          FROM disputes d
          JOIN submissions s ON s.id = d.submission_id
          JOIN bounties b ON b.id = s.bounty_id
          WHERE s.freelancer_id = ANY($1::uuid[])
            AND d.resolved_at IS NOT NULL

          UNION ALL

          SELECT b.creator_id AS user_id,
                 CONCAT('Dispute resolved: ', b.title) AS story,
                 d.resolved_at AS happened_at
          FROM disputes d
          JOIN submissions s ON s.id = d.submission_id
          JOIN bounties b ON b.id = s.bounty_id
          WHERE b.creator_id = ANY($1::uuid[])
            AND d.resolved_at IS NOT NULL
        ) stories
        ORDER BY stories.happened_at DESC
      `,
      [userIds],
    );

    const storiesByUser = new Map<string, Array<{ label: string; at: string }>>();
    for (const row of stories.rows) {
      const current = storiesByUser.get(row.user_id) ?? [];
      if (current.length >= 5) {
        continue;
      }

      current.push({ label: row.story, at: row.happened_at });
      storiesByUser.set(row.user_id, current);
    }

    return response.status(200).json({
      data: users.rows.map((row) => ({
        id: row.id,
        name: row.name,
        role: String(row.role).toUpperCase(),
        reputationScore: row.reputation_score,
        walletAddress: row.wallet_address,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedCount: completedByUser.get(row.id) ?? 0,
        recentCompletedBounties: completedListByUser.get(row.id) ?? [],
        recentStories: storiesByUser.get(row.id) ?? [],
      })),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id/feed", validateParams(userIdParamsSchema), async (request, response, next) => {
  try {
    const user = await dbQuery<{
      id: string;
      name: string;
      role: string;
      wallet_address: string | null;
      reputation_score: number;
      created_at: string;
      updated_at: string;
    }>(
      `
        SELECT u.id,
               COALESCE(NULLIF(u.display_name, ''), NULLIF(u.email, ''), CONCAT('User ', LEFT(u.wallet_address, 8))) AS name,
               u.role::text AS role,
               u.wallet_address,
               u.reputation_score,
               u.created_at::text,
               u.updated_at::text
        FROM users u
        WHERE u.id = $1
          AND u.deleted_at IS NULL
          AND u.is_banned = FALSE
        LIMIT 1
      `,
      [request.params.id],
    );

    if ((user.rowCount ?? 0) === 0) {
      return response.status(404).json({
        error: "Not found",
        code: 404,
        detail: "User not found",
      });
    }

    const role = String(user.rows[0].role).toLowerCase();
    const userId = user.rows[0].id;

    const stats = await dbQuery<{
      posted_bounties: number;
      completed_bounties: number;
      passed_submissions: number;
      active_disputes: number;
    }>(
      `
        SELECT
          (SELECT COUNT(*)::int FROM bounties b WHERE b.creator_id = $1 AND b.deleted_at IS NULL) AS posted_bounties,
          (SELECT COUNT(*)::int FROM bounties b WHERE b.creator_id = $1 AND b.status = 'completed' AND b.deleted_at IS NULL) AS completed_bounties,
          (SELECT COUNT(*)::int FROM submissions s WHERE s.freelancer_id = $1 AND s.status = 'passed') AS passed_submissions,
          (
            SELECT COUNT(*)::int
            FROM disputes d
            JOIN submissions s ON s.id = d.submission_id
            JOIN bounties b ON b.id = s.bounty_id
            WHERE d.status IN ('open', 'under_review', 'escalated')
              AND (b.creator_id = $1 OR s.freelancer_id = $1)
          ) AS active_disputes
      `,
      [userId],
    );

    const completed = await dbQuery<{
      bounty_id: string;
      title: string;
      completed_at: string;
      as_role: string;
    }>(
      `
        SELECT ranked.bounty_id,
               ranked.title,
               ranked.completed_at::text,
               ranked.as_role
        FROM (
          SELECT b.id AS bounty_id,
                 b.title,
                 b.updated_at AS completed_at,
                 'CLIENT'::text AS as_role
          FROM bounties b
          WHERE b.creator_id = $1
            AND b.status = 'completed'
            AND b.deleted_at IS NULL

          UNION ALL

          SELECT b.id AS bounty_id,
                 b.title,
                 COALESCE(s.score_finalized_at, s.updated_at) AS completed_at,
                 'FREELANCER'::text AS as_role
          FROM submissions s
          JOIN bounties b ON b.id = s.bounty_id
          WHERE s.freelancer_id = $1
            AND s.status = 'passed'
            AND b.deleted_at IS NULL
        ) ranked
        ORDER BY ranked.completed_at DESC
        LIMIT 12
      `,
      [userId],
    );

    const stories = await dbQuery<{ label: string; at: string }>(
      `
        SELECT feed.story AS label,
               feed.happened_at::text AS at
        FROM (
          SELECT CONCAT('Posted bounty: ', b.title) AS story,
                 b.created_at AS happened_at
          FROM bounties b
          WHERE b.creator_id = $1
            AND b.deleted_at IS NULL

          UNION ALL

          SELECT CONCAT('Completed bounty: ', b.title) AS story,
                 b.updated_at AS happened_at
          FROM bounties b
          WHERE b.creator_id = $1
            AND b.status = 'completed'
            AND b.deleted_at IS NULL

          UNION ALL

          SELECT CONCAT('Completed delivery: ', b.title) AS story,
                 COALESCE(s.score_finalized_at, s.updated_at) AS happened_at
          FROM submissions s
          JOIN bounties b ON b.id = s.bounty_id
          WHERE s.freelancer_id = $1
            AND s.status = 'passed'
            AND b.deleted_at IS NULL

          UNION ALL

          SELECT CONCAT('Dispute resolved: ', b.title) AS story,
                 d.resolved_at AS happened_at
          FROM disputes d
          JOIN submissions s ON s.id = d.submission_id
          JOIN bounties b ON b.id = s.bounty_id
          WHERE (b.creator_id = $1 OR s.freelancer_id = $1)
            AND d.resolved_at IS NOT NULL
        ) feed
        ORDER BY feed.happened_at DESC
        LIMIT 20
      `,
      [userId],
    );

    return response.status(200).json({
      user: {
        ...user.rows[0],
        role: String(user.rows[0].role).toUpperCase(),
      },
      stats: {
        postedBounties: stats.rows[0]?.posted_bounties ?? 0,
        completedBounties: stats.rows[0]?.completed_bounties ?? 0,
        passedSubmissions: stats.rows[0]?.passed_submissions ?? 0,
        activeDisputes: stats.rows[0]?.active_disputes ?? 0,
      },
      recentCompletedBounties: completed.rows.map((row) => ({
        id: row.bounty_id,
        title: row.title,
        completedAt: row.completed_at,
        asRole: row.as_role,
      })),
      recentStories: stories.rows,
      perspectiveRole:
        role === "client" ? "CLIENT" : role === "freelancer" ? "FREELANCER" : "ADMIN",
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/me/summary", requireAuth, async (request, response, next) => {
  try {
    if (!request.user) {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "Login required",
      });
    }

    const summary = await dbQuery<{
      bounties_posted: number;
      total_paid_out: string;
      completed_bounties: number;
      submissions_count: number;
      passed_submissions: number;
      avg_score: string;
      total_earned: string;
      disputes_count: number;
    }>(
      `
        SELECT
          (
            SELECT COUNT(*)::int
            FROM bounties b
            WHERE b.creator_id = $1
              AND b.deleted_at IS NULL
          ) AS bounties_posted,
          (
            SELECT COALESCE(SUM(p.actual_amount), 0)::text
            FROM payouts p
            JOIN submissions s ON s.id = p.submission_id
            JOIN bounties b ON b.id = s.bounty_id
            WHERE b.creator_id = $1
              AND p.status = 'completed'
          ) AS total_paid_out,
          (
            SELECT COUNT(*)::int
            FROM bounties b
            WHERE b.creator_id = $1
              AND b.status = 'completed'
              AND b.deleted_at IS NULL
          ) AS completed_bounties,
          (
            SELECT COUNT(*)::int
            FROM submissions s
            WHERE s.freelancer_id = $1
          ) AS submissions_count,
          (
            SELECT COUNT(*)::int
            FROM submissions s
            WHERE s.freelancer_id = $1
              AND s.status = 'passed'
          ) AS passed_submissions,
          (
            SELECT COALESCE(AVG(s.final_score), 0)::text
            FROM submissions s
            WHERE s.freelancer_id = $1
              AND s.final_score IS NOT NULL
          ) AS avg_score,
          (
            SELECT COALESCE(SUM(p.actual_amount), 0)::text
            FROM payouts p
            WHERE p.freelancer_id = $1
              AND p.status = 'completed'
          ) AS total_earned,
          (
            SELECT COUNT(*)::int
            FROM disputes d
            JOIN submissions s ON s.id = d.submission_id
            JOIN bounties b ON b.id = s.bounty_id
            WHERE b.creator_id = $1
               OR s.freelancer_id = $1
          ) AS disputes_count
      `,
      [request.user.userId],
    );

    const totals = await dbQuery<{ total_bounties: number }>(
      `
        SELECT COUNT(*)::int AS total_bounties
        FROM bounties
        WHERE creator_id = $1
          AND deleted_at IS NULL
      `,
      [request.user.userId],
    );

    const posted = Number(summary.rows[0]?.bounties_posted ?? 0);
    const completed = Number(summary.rows[0]?.completed_bounties ?? 0);
    const fulfillmentRate = posted === 0 ? 0 : Math.round((completed / posted) * 100);

    return response.status(200).json({
      client: {
        bounties_posted: posted,
        total_paid_out: summary.rows[0]?.total_paid_out ?? "0",
        avg_fulfillment_rate: fulfillmentRate,
        total_bounties: Number(totals.rows[0]?.total_bounties ?? 0),
      },
      freelancer: {
        submissions: Number(summary.rows[0]?.submissions_count ?? 0),
        passed: Number(summary.rows[0]?.passed_submissions ?? 0),
        avg_score: Number(summary.rows[0]?.avg_score ?? "0"),
        total_earned: summary.rows[0]?.total_earned ?? "0",
      },
      disputes_count: Number(summary.rows[0]?.disputes_count ?? 0),
    });
  } catch (error) {
    if (HACKATHON_MODE && isDbConnectionError(error) && request.user) {
      return response.status(200).json({
        client: {
          bounties_posted: 0,
          total_paid_out: "0",
          avg_fulfillment_rate: 0,
          total_bounties: 0,
        },
        freelancer: {
          submissions: 0,
          passed: 0,
          avg_score: 0,
          total_earned: "0",
        },
        disputes_count: 0,
      });
    }
    return next(error);
  }
});

router.get("/me/activities", requireAuth, validateQuery(activityQuerySchema), async (request, response, next) => {
  try {
    if (!request.user) {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "Login required",
      });
    }

    const query = request.query as unknown as {
      type: "bounties" | "submissions" | "payouts" | "disputes";
      page: number;
      page_size: number;
      from?: string;
      to?: string;
    };

    const offset = (query.page - 1) * query.page_size;

    if (query.type === "bounties") {
      const params: Array<string | number> = [request.user.userId];
      const filters: string[] = ["b.creator_id = $1", "b.deleted_at IS NULL"];

      if (query.from) {
        params.push(query.from);
        filters.push(`b.created_at >= $${params.length}::timestamptz`);
      }

      if (query.to) {
        params.push(query.to);
        filters.push(`b.created_at <= $${params.length}::timestamptz`);
      }

      params.push(query.page_size, offset);

      const rows = await dbQuery<{
        id: string;
        title: string;
        status: string;
        deadline: string;
        created_at: string;
      }>(
        `
          SELECT b.id,
                 b.title,
                 b.status::text AS status,
                 b.deadline::text AS deadline,
                 b.created_at::text AS created_at
          FROM bounties b
          WHERE ${filters.join(" AND ")}
          ORDER BY b.created_at DESC
          LIMIT $${params.length - 1}
          OFFSET $${params.length}
        `,
        params,
      );

      return response.status(200).json({ data: rows.rows });
    }

    if (query.type === "submissions") {
      const params: Array<string | number> = [request.user.userId];
      const filters: string[] = ["s.freelancer_id = $1"];

      if (query.from) {
        params.push(query.from);
        filters.push(`s.created_at >= $${params.length}::timestamptz`);
      }

      if (query.to) {
        params.push(query.to);
        filters.push(`s.created_at <= $${params.length}::timestamptz`);
      }

      params.push(query.page_size, offset);

      const rows = await dbQuery<{
        id: string;
        bounty_id: string;
        bounty_title: string;
        status: string;
        final_score: number | null;
        created_at: string;
      }>(
        `
          SELECT s.id,
                 s.bounty_id,
                 b.title AS bounty_title,
                 s.status::text AS status,
                 s.final_score,
                 s.created_at::text AS created_at
          FROM submissions s
          JOIN bounties b ON b.id = s.bounty_id
          WHERE ${filters.join(" AND ")}
          ORDER BY s.created_at DESC
          LIMIT $${params.length - 1}
          OFFSET $${params.length}
        `,
        params,
      );

      return response.status(200).json({ data: rows.rows });
    }

    if (query.type === "payouts") {
      const params: Array<string | number> = [request.user.userId];
      const filters: string[] = ["p.freelancer_id = $1"];

      if (query.from) {
        params.push(query.from);
        filters.push(`p.created_at >= $${params.length}::timestamptz`);
      }

      if (query.to) {
        params.push(query.to);
        filters.push(`p.created_at <= $${params.length}::timestamptz`);
      }

      params.push(query.page_size, offset);

      const rows = await dbQuery<{
        id: string;
        bounty_id: string;
        bounty_title: string;
        amount: string | null;
        tx_id: string | null;
        status: string;
        created_at: string;
      }>(
        `
          SELECT p.id,
                 s.bounty_id,
                 b.title AS bounty_title,
                 p.actual_amount::text AS amount,
                 p.tx_id,
                 p.status::text AS status,
                 p.created_at::text AS created_at
          FROM payouts p
          JOIN submissions s ON s.id = p.submission_id
          JOIN bounties b ON b.id = s.bounty_id
          WHERE ${filters.join(" AND ")}
          ORDER BY p.created_at DESC
          LIMIT $${params.length - 1}
          OFFSET $${params.length}
        `,
        params,
      );

      return response.status(200).json({ data: rows.rows });
    }

    const params: Array<string | number> = [request.user.userId];
    const filters: string[] = [
      `(
        b.creator_id = $1
        OR s.freelancer_id = $1
        OR EXISTS (
          SELECT 1
          FROM dispute_votes dv
          WHERE dv.dispute_id = d.id
            AND dv.arbitrator_id = $1
        )
      )`,
    ];

    if (query.from) {
      params.push(query.from);
      filters.push(`d.raised_at >= $${params.length}::timestamptz`);
    }

    if (query.to) {
      params.push(query.to);
      filters.push(`d.raised_at <= $${params.length}::timestamptz`);
    }

    params.push(query.page_size, offset);

    const rows = await dbQuery<{
      id: string;
      bounty_title: string;
      dispute_type: string;
      status: string;
      raised_at: string;
    }>(
      `
        SELECT d.id,
               b.title AS bounty_title,
               d.dispute_type::text AS dispute_type,
               d.status::text AS status,
               d.raised_at::text AS raised_at
        FROM disputes d
        JOIN submissions s ON s.id = d.submission_id
        JOIN bounties b ON b.id = s.bounty_id
        WHERE ${filters.join(" AND ")}
        ORDER BY d.raised_at DESC
        LIMIT $${params.length - 1}
        OFFSET $${params.length}
      `,
      params,
    );

    return response.status(200).json({ data: rows.rows });
  } catch (error) {
    return next(error);
  }
});

router.get("/me/payouts", requireAuth, validateQuery(payoutsQuerySchema), async (request, response, next) => {
  try {
    if (!request.user) {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "Login required",
      });
    }

    const query = request.query as unknown as {
      page: number;
      page_size: number;
      from?: string;
      to?: string;
    };

    const offset = (query.page - 1) * query.page_size;
    const params: Array<string | number> = [request.user.userId];
    const filters: string[] = ["p.freelancer_id = $1"];

    if (query.from) {
      params.push(query.from);
      filters.push(`p.created_at >= $${params.length}::timestamptz`);
    }

    if (query.to) {
      params.push(query.to);
      filters.push(`p.created_at <= $${params.length}::timestamptz`);
    }

    params.push(query.page_size, offset);

    const rows = await dbQuery<{
      id: string;
      bounty_id: string;
      bounty_title: string;
      amount: string | null;
      tx_id: string | null;
      status: string;
      created_at: string;
    }>(
      `
        SELECT p.id,
               s.bounty_id,
               b.title AS bounty_title,
               p.actual_amount::text AS amount,
               p.tx_id,
               p.status::text AS status,
               p.created_at::text AS created_at
        FROM payouts p
        JOIN submissions s ON s.id = p.submission_id
        JOIN bounties b ON b.id = s.bounty_id
        WHERE ${filters.join(" AND ")}
        ORDER BY p.created_at DESC
        LIMIT $${params.length - 1}
        OFFSET $${params.length}
      `,
      params,
    );

    return response.status(200).json({ data: rows.rows });
  } catch (error) {
    return next(error);
  }
});

router.get("/me/stats", requireAuth, async (request, response, next) => {
  try {
    if (!request.user) {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "Login required",
      });
    }

    const profile = await dbQuery<{
      role: string;
      reputation_score: number;
      wallet_address: string | null;
    }>(
      `
        SELECT role, reputation_score, wallet_address
        FROM users
        WHERE id = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [request.user.userId],
    );

    if ((profile.rowCount ?? 0) === 0) {
      return response.status(404).json({
        error: "Not found",
        code: 404,
        detail: "User profile not found",
      });
    }

    const counts = await dbQuery<{
      active_count: number;
      completed_count: number;
      disputed_count: number;
      escrow_total: string;
      locked_escrow_total: string;
      total_paid_out: string;
      total_earned: string;
      pending_payout_total: string;
    }>(
      `
        SELECT COUNT(*) FILTER (WHERE b.status IN ('open', 'in_progress', 'accepted'))::int AS active_count,
               COUNT(*) FILTER (WHERE b.status = 'completed')::int AS completed_count,
               COUNT(*) FILTER (WHERE b.status = 'disputed')::int AS disputed_count,
               COALESCE(SUM(b.total_amount), 0)::text AS escrow_total,
               COALESCE(SUM(b.total_amount) FILTER (
                 WHERE b.creator_id = $1
                   AND b.escrow_locked = TRUE
                   AND b.status IN ('open', 'in_progress', 'disputed')
               ), 0)::text AS locked_escrow_total,
               (
                 SELECT COALESCE(SUM(p.actual_amount), 0)::text
                 FROM payouts p
                 JOIN submissions s ON s.id = p.submission_id
                 JOIN bounties b_paid ON b_paid.id = s.bounty_id
                 WHERE b_paid.creator_id = $1
                   AND p.status = 'completed'
               ) AS total_paid_out,
               (
                 SELECT COALESCE(SUM(p.actual_amount), 0)::text
                 FROM payouts p
                 WHERE p.freelancer_id = $1
                   AND p.status = 'completed'
               ) AS total_earned,
               (
                 SELECT COALESCE(SUM(p.actual_amount), 0)::text
                 FROM payouts p
                 WHERE p.freelancer_id = $1
                   AND p.status IN ('pending', 'processing', 'quarantined')
               ) AS pending_payout_total
        FROM bounties b
        WHERE b.deleted_at IS NULL
          AND (
            (CASE WHEN $2 = 'client' THEN b.creator_id = $1 ELSE FALSE END)
            OR (
              CASE
                WHEN $2 <> 'client' THEN EXISTS (
                  SELECT 1
                  FROM submissions s
                  WHERE s.bounty_id = b.id
                    AND s.freelancer_id = $1
                )
                ELSE FALSE
              END
            )
            OR (
              CASE
                WHEN $2 <> 'client' THEN EXISTS (
                  SELECT 1
                  FROM project_applications pa
                  WHERE pa.bounty_id = b.id
                    AND pa.freelancer_id = $1
                    AND pa.status = 'selected'
                )
                ELSE FALSE
              END
            )
          )
      `,
      [request.user.userId, profile.rows[0].role],
    );

    let walletBalanceMicroAlgo = 0n;
    let walletBalanceAvailable = true;
    let walletBalanceSource = "none";
    if (profile.rows[0].wallet_address) {
      if (ALGOD_MOCK_MODE) {
        const override = await loadMockWalletBalanceMicroAlgo(request.user.userId);
        if (override !== null) {
          walletBalanceMicroAlgo = override;
          walletBalanceSource = "mock_override";
        } else {
          try {
            walletBalanceMicroAlgo = await algorandService.getWalletBalanceMicroAlgo(profile.rows[0].wallet_address);
            walletBalanceSource = "mock_default";
          } catch {
            walletBalanceMicroAlgo = 0n;
            walletBalanceAvailable = false;
            walletBalanceSource = "mock_unavailable";
          }
        }
      } else {
        try {
          walletBalanceMicroAlgo = await algorandService.getWalletBalanceMicroAlgo(profile.rows[0].wallet_address);
          walletBalanceSource = "onchain";
        } catch {
          walletBalanceMicroAlgo = 0n;
          walletBalanceAvailable = false;
          walletBalanceSource = "unavailable";
        }
      }
    }

    return response.status(200).json({
      role: profile.rows[0].role,
      reputation: profile.rows[0].reputation_score,
      active_bounties: Number(counts.rows[0]?.active_count ?? 0),
      completed_bounties: Number(counts.rows[0]?.completed_count ?? 0),
      disputed_bounties: Number(counts.rows[0]?.disputed_count ?? 0),
      escrow_total: counts.rows[0]?.escrow_total ?? "0",
      locked_escrow_microalgo: counts.rows[0]?.locked_escrow_total ?? "0",
      locked_escrow_algo: Number(counts.rows[0]?.locked_escrow_total ?? "0") / 1_000_000,
      total_paid_out_microalgo: counts.rows[0]?.total_paid_out ?? "0",
      total_paid_out_algo: Number(counts.rows[0]?.total_paid_out ?? "0") / 1_000_000,
      total_earned_microalgo: counts.rows[0]?.total_earned ?? "0",
      total_earned_algo: Number(counts.rows[0]?.total_earned ?? "0") / 1_000_000,
      pending_payout_microalgo: counts.rows[0]?.pending_payout_total ?? "0",
      pending_payout_algo: Number(counts.rows[0]?.pending_payout_total ?? "0") / 1_000_000,
      wallet_balance_microalgo: walletBalanceMicroAlgo.toString(),
      wallet_balance_algo: Number(walletBalanceMicroAlgo) / 1_000_000,
      wallet_balance_available: walletBalanceAvailable,
      wallet_balance_source: walletBalanceSource,
      wallet_balance_network: ALGORAND_NETWORK,
      wallet_mock_mode: ALGOD_MOCK_MODE,
    });
  } catch (error) {
    if (HACKATHON_MODE && isDbConnectionError(error) && request.user) {
      return response.status(200).json({
        role: request.user.role,
        reputation: 100,
        active_bounties: 0,
        completed_bounties: 0,
        disputed_bounties: 0,
        escrow_total: "0",
        locked_escrow_microalgo: "0",
        locked_escrow_algo: 0,
        total_paid_out_microalgo: "0",
        total_paid_out_algo: 0,
        total_earned_microalgo: "0",
        total_earned_algo: 0,
        pending_payout_microalgo: "0",
        pending_payout_algo: 0,
        wallet_balance_microalgo: "0",
        wallet_balance_algo: 0,
        wallet_balance_available: false,
        wallet_balance_source: "unavailable",
        wallet_balance_network: ALGORAND_NETWORK,
        wallet_mock_mode: ALGOD_MOCK_MODE,
      });
    }
    return next(error);
  }
});

router.get("/me/wallet-transactions", requireAuth, validateQuery(walletTransactionsQuerySchema), async (request, response, next) => {
  try {
    if (!request.user) {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "Login required",
      });
    }

    const query = request.query as unknown as { limit: number };
    const profile = await dbQuery<{ wallet_address: string | null }>(
      `
        SELECT wallet_address
        FROM users
        WHERE id = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [request.user.userId],
    );

    if ((profile.rowCount ?? 0) === 0) {
      return response.status(404).json({
        error: "Not found",
        code: 404,
        detail: "User profile not found",
      });
    }

    const walletAddress = String(profile.rows[0]?.wallet_address ?? "").trim().toUpperCase();
    if (!walletAddress) {
      return response.status(400).json({
        error: "Invalid wallet",
        code: 400,
        detail: "Link wallet address before loading transactions",
      });
    }

    const explorerTxBase = ALGORAND_NETWORK.includes("mainnet")
      ? "https://algoexplorer.io/tx"
      : "https://testnet.algoexplorer.io/tx";

    try {
      const items = await algorandService.listWalletTransactions(walletAddress, query.limit);
      const data = items.map((tx: WalletTransactionView) => {
        const direction = tx.sender === walletAddress && tx.receiver === walletAddress
          ? "self"
          : tx.receiver === walletAddress
            ? "in"
            : tx.sender === walletAddress
              ? "out"
              : "unknown";

        return {
          id: tx.id,
          type: tx.type,
          sender: tx.sender,
          receiver: tx.receiver,
          amount_micro_algo: tx.amountMicroAlgo,
          fee_micro_algo: tx.feeMicroAlgo,
          direction,
          round_time_unix: tx.roundTimeUnix,
          confirmed_round: tx.confirmedRound,
          explorer_url: `${explorerTxBase}/${tx.id}`,
        };
      });

      return response.status(200).json({
        network: ALGORAND_NETWORK.includes("mainnet") ? "mainnet" : "testnet",
        wallet: walletAddress,
        source: "indexer",
        transactions: data,
      });
    } catch {
      const fallback = await dbQuery<{
        tx_id: string;
        amount_microalgo: string;
        created_at_unix: number;
      }>(
        `
          SELECT p.tx_id,
                 COALESCE(p.actual_amount, 0)::text AS amount_microalgo,
                 EXTRACT(EPOCH FROM p.created_at)::int AS created_at_unix
          FROM payouts p
          LEFT JOIN submissions s ON s.id = p.submission_id
          LEFT JOIN bounties b ON b.id = s.bounty_id
          WHERE p.tx_id IS NOT NULL
            AND (
              p.freelancer_id = $1
              OR b.creator_id = $1
            )
          ORDER BY p.created_at DESC
          LIMIT $2
        `,
        [request.user.userId, query.limit],
      );

      const data = fallback.rows.map((row) => ({
        id: row.tx_id,
        type: "payment",
        sender: "",
        receiver: "",
        amount_micro_algo: Number(row.amount_microalgo ?? "0"),
        fee_micro_algo: 0,
        direction: "unknown",
        round_time_unix: Number(row.created_at_unix ?? 0),
        confirmed_round: 0,
        explorer_url: `${explorerTxBase}/${row.tx_id}`,
      }));

      return response.status(200).json({
        network: ALGORAND_NETWORK.includes("mainnet") ? "mainnet" : "testnet",
        wallet: walletAddress,
        source: "fallback_db",
        transactions: data,
      });
    }
  } catch (error) {
    return next(error);
  }
});

router.post("/me/mock-balance", requireAuth, validateBody(mockWalletBalanceSchema), async (request, response, next) => {
  try {
    if (!request.user) {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "Login required",
      });
    }

    if (!ALGOD_MOCK_MODE) {
      return response.status(400).json({
        error: "Invalid operation",
        code: 400,
        detail: "Mock balance is only available when ALGOD_MOCK_MODE=true",
      });
    }

    const profile = await dbQuery<{ wallet_address: string | null }>(
      `
        SELECT wallet_address
        FROM users
        WHERE id = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [request.user.userId],
    );

    if ((profile.rowCount ?? 0) === 0) {
      return response.status(404).json({
        error: "Not found",
        code: 404,
        detail: "User profile not found",
      });
    }

    if (!profile.rows[0].wallet_address) {
      return response.status(400).json({
        error: "Invalid wallet",
        code: 400,
        detail: "Link a wallet before adding mock funds",
      });
    }

    const amountAlgo = Number(request.body.amount_algo);
    const amountMicroAlgo = BigInt(Math.trunc(amountAlgo * 1_000_000));

    await dbQuery(
      `
        INSERT INTO mock_wallet_balances (user_id, wallet_address, balance_microalgo)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id)
        DO UPDATE SET wallet_address = EXCLUDED.wallet_address,
                      balance_microalgo = EXCLUDED.balance_microalgo,
                      updated_at = NOW()
      `,
      [request.user.userId, profile.rows[0].wallet_address, amountMicroAlgo.toString()],
    );

    return response.status(200).json({
      wallet_balance_microalgo: amountMicroAlgo.toString(),
      wallet_balance_algo: Number(amountMicroAlgo) / 1_000_000,
      wallet_balance_source: "mock_override",
      wallet_balance_network: ALGORAND_NETWORK,
      wallet_mock_mode: true,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/me", requireAuth, async (request, response, next) => {
  try {
    if (!request.user) {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "Login required",
      });
    }

    const sql = `
      SELECT id, email, wallet_address, role, reputation_score, is_sanctions_flagged, is_banned, created_at, updated_at
      FROM users
      WHERE id = $1
        AND deleted_at IS NULL
      LIMIT 1
    `;

    const result = await dbQuery<{
      id: string;
      email: string | null;
      wallet_address: string | null;
      role: string;
      reputation_score: number;
      is_sanctions_flagged: boolean;
      is_banned: boolean;
      created_at: Date;
      updated_at: Date;
    }>(sql, [request.user.userId]);

    if (result.rowCount === 0) {
      return response.status(404).json({
        error: "Not found",
        code: 404,
        detail: "User profile not found",
      });
    }

    return response.status(200).json({
      user: result.rows[0],
      wallet_linked: Boolean(result.rows[0].wallet_address),
    });
  } catch (error) {
    if (HACKATHON_MODE && isDbConnectionError(error) && request.user) {
      return response.status(200).json({
        user: {
          id: request.user.userId,
          email: null,
          wallet_address: request.user.walletAddress,
          role: request.user.role,
          reputation_score: 100,
          is_sanctions_flagged: false,
          is_banned: false,
          created_at: new Date(0).toISOString(),
          updated_at: new Date().toISOString(),
        },
        wallet_linked: Boolean(request.user.walletAddress),
      });
    }
    return next(error);
  }
});

router.patch("/me", requireAuth, validateBody(updateProfileSchema), async (request, response, next) => {
  try {
    if (!request.user) {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "Login required",
      });
    }

    const walletInput = typeof request.body.wallet_address === "string" ? request.body.wallet_address.trim() : "";
    let normalizedWallet: string | null = null;

    if (walletInput.length > 0) {
      normalizedWallet = normalizeWalletAddress(walletInput);
      if (!isValidAlgorandAddress(normalizedWallet)) {
        return response.status(400).json({
          error: "Invalid wallet",
          code: 400,
          detail: "wallet_address is not a valid Algorand address",
        });
      }

      const existingWalletOwner = await dbQuery<{ id: string }>(
        `
          SELECT id
          FROM users
          WHERE wallet_address = $1
            AND id <> $2
            AND deleted_at IS NULL
          LIMIT 1
        `,
        [normalizedWallet, request.user.userId],
      );

      if ((existingWalletOwner.rowCount ?? 0) > 0) {
        return response.status(409).json({
          error: "Conflict",
          code: 409,
          detail: "wallet_address is already linked to another account",
        });
      }
    }

    const sql = `
      UPDATE users
      SET email = COALESCE($1, email),
          wallet_address = COALESCE($2, wallet_address)
      WHERE id = $3
        AND deleted_at IS NULL
      RETURNING id, email, wallet_address, role, reputation_score, is_sanctions_flagged, is_banned, created_at, updated_at
    `;

    const updated = await dbQuery(sql, [request.body.email ?? null, normalizedWallet, request.user.userId]);
    return response.status(200).json({ user: updated.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id/public", requireAuth, validateParams(userIdParamsSchema), async (request, response, next) => {
  try {
    if (!request.user) {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "Login required",
      });
    }

    const result = await dbQuery<{
      id: string;
      name: string;
      role: string;
      wallet_address: string | null;
      reputation_score: number;
      created_at: string;
    }>(
      `
        SELECT u.id,
               COALESCE(NULLIF(u.display_name, ''), NULLIF(u.email, ''), u.wallet_address) AS name,
               u.role::text AS role,
               u.wallet_address,
               u.reputation_score,
               u.created_at::text AS created_at
        FROM users u
        WHERE u.id = $1
          AND u.deleted_at IS NULL
        LIMIT 1
      `,
      [request.params.id],
    );

    if ((result.rowCount ?? 0) === 0) {
      return response.status(404).json({
        error: "Not found",
        code: 404,
        detail: "User not found",
      });
    }

    return response.status(200).json({
      user: {
        ...result.rows[0],
        role: String(result.rows[0].role).toUpperCase(),
      },
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
