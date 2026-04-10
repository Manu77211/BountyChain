import { Router } from "express";
import { dbQuery } from "../../lib/db/client";
import { validateParams, validateQuery } from "../middleware/validate";
import { freelancerIdParamSchema, freelancerListQuerySchema } from "../schemas/freelancer.schema";

const router = Router();

router.get("/", validateQuery(freelancerListQuerySchema), async (request, response, next) => {
  try {
    const query = request.query as unknown as {
      skills?: string;
      rating?: number;
      limit: number;
    };

    const result = await dbQuery<{
      id: string;
      name: string | null;
      reputation_score: number;
    }>(
      `
        SELECT id,
               COALESCE(display_name, email, CONCAT('Freelancer ', LEFT(wallet_address, 6))) AS name,
               reputation_score
        FROM users
        WHERE role = 'freelancer'
          AND deleted_at IS NULL
          AND is_banned = FALSE
          AND (
            $1::text IS NULL
            OR LOWER(COALESCE(display_name, '')) LIKE CONCAT('%', LOWER($1), '%')
            OR LOWER(COALESCE(email, '')) LIKE CONCAT('%', LOWER($1), '%')
          )
          AND (
            $2::numeric IS NULL
            OR reputation_score >= ($2::numeric * 20)
          )
        ORDER BY reputation_score DESC, created_at DESC
        LIMIT $3
      `,
      [query.skills ?? null, query.rating ?? null, query.limit],
    );

    const freelancers = result.rows.map((row) => ({
      id: row.id,
      name: row.name ?? "Freelancer",
      rating: Number((row.reputation_score / 20).toFixed(2)),
      trustScore: row.reputation_score,
      experience: "",
      skills: [],
    }));

    return response.status(200).json(freelancers);
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", validateParams(freelancerIdParamSchema), async (request, response, next) => {
  try {
    const freelancerId = request.params.id;

    const profileResult = await dbQuery<{
      id: string;
      name: string | null;
      email: string | null;
      reputation_score: number;
      is_sanctions_flagged: boolean;
      is_banned: boolean;
      created_at: string;
    }>(
      `
        SELECT id,
               COALESCE(display_name, email, CONCAT('Freelancer ', LEFT(wallet_address, 6))) AS name,
               email,
               reputation_score,
               is_sanctions_flagged,
               is_banned,
               created_at
        FROM users
        WHERE id = $1
          AND role = 'freelancer'
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [freelancerId],
    );

    if ((profileResult.rowCount ?? 0) === 0) {
      return response.status(404).json({
        error: "Not found",
        code: 404,
        detail: "Freelancer not found",
      });
    }

    const statsResult = await dbQuery<{
      total_submissions: number;
      passed_submissions: number;
      disputed_submissions: number;
      active_bounties: number;
    }>(
      `
        SELECT
          COUNT(*)::int AS total_submissions,
          COUNT(*) FILTER (WHERE s.status = 'passed')::int AS passed_submissions,
          COUNT(*) FILTER (WHERE s.status = 'disputed')::int AS disputed_submissions,
          COUNT(DISTINCT s.bounty_id) FILTER (WHERE s.status IN ('submitted', 'validating', 'passed'))::int AS active_bounties
        FROM submissions s
        WHERE s.freelancer_id = $1
      `,
      [freelancerId],
    );

    const recentWorkResult = await dbQuery<{
      bounty_id: string;
      title: string;
      submission_status: string;
      submitted_at: string;
      final_score: number | null;
    }>(
      `
        SELECT s.bounty_id,
               b.title,
               s.status AS submission_status,
               s.submission_received_at AS submitted_at,
               s.final_score
        FROM submissions s
        JOIN bounties b ON b.id = s.bounty_id
        WHERE s.freelancer_id = $1
          AND b.deleted_at IS NULL
        ORDER BY s.submission_received_at DESC
        LIMIT 10
      `,
      [freelancerId],
    );

    const profile = profileResult.rows[0];
    const stats = statsResult.rows[0] ?? {
      total_submissions: 0,
      passed_submissions: 0,
      disputed_submissions: 0,
      active_bounties: 0,
    };

    return response.status(200).json({
      id: profile.id,
      name: profile.name ?? "Freelancer",
      email: profile.email,
      rating: Number((profile.reputation_score / 20).toFixed(2)),
      trustScore: profile.reputation_score,
      experience: "",
      skills: [],
      createdAt: profile.created_at,
      isSanctionsFlagged: profile.is_sanctions_flagged,
      isBanned: profile.is_banned,
      stats: {
        totalSubmissions: stats.total_submissions,
        passedSubmissions: stats.passed_submissions,
        disputedSubmissions: stats.disputed_submissions,
        activeBounties: stats.active_bounties,
      },
      recentWork: recentWorkResult.rows.map((row) => ({
        bountyId: row.bounty_id,
        title: row.title,
        submissionStatus: row.submission_status,
        submittedAt: row.submitted_at,
        finalScore: row.final_score,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

export default router;