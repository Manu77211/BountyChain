import { Router } from "express";
import { z } from "zod";
import { dbQuery } from "../../lib/db/client";
import { requireAuth } from "../middleware/auth";
import { validateBody, validateQuery } from "../middleware/validate";

const router = Router();

const updateProfileSchema = z.object({
  email: z.string().email().optional(),
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
    }>(
      `
        SELECT role, reputation_score
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
    }>(
      `
        SELECT COUNT(*) FILTER (WHERE b.status IN ('open', 'in_progress', 'accepted'))::int AS active_count,
               COUNT(*) FILTER (WHERE b.status = 'completed')::int AS completed_count,
               COUNT(*) FILTER (WHERE b.status = 'disputed')::int AS disputed_count,
               COALESCE(SUM(b.total_amount), 0)::text AS escrow_total
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

    return response.status(200).json({
      role: profile.rows[0].role,
      reputation: profile.rows[0].reputation_score,
      active_bounties: Number(counts.rows[0]?.active_count ?? 0),
      completed_bounties: Number(counts.rows[0]?.completed_count ?? 0),
      disputed_bounties: Number(counts.rows[0]?.disputed_count ?? 0),
      escrow_total: counts.rows[0]?.escrow_total ?? "0",
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

    const sql = `
      UPDATE users
      SET email = COALESCE($1, email)
      WHERE id = $2
        AND deleted_at IS NULL
      RETURNING id, email, wallet_address, role, reputation_score, is_sanctions_flagged, is_banned, created_at, updated_at
    `;

    const updated = await dbQuery(sql, [request.body.email ?? null, request.user.userId]);
    return response.status(200).json({ user: updated.rows[0] });
  } catch (error) {
    return next(error);
  }
});

export default router;
