import { Router } from "express";
import { dbQuery } from "../../lib/db/client";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { validateBody, validateParams, validateQuery } from "../middleware/validate";
import {
  freelancerIdParamSchema,
  freelancerListQuerySchema,
  freelancerRecommendationBodySchema,
} from "../schemas/freelancer.schema";

const router = Router();

function extractKeywords(input: string) {
  const stopWords = new Set([
    "about",
    "after",
    "also",
    "build",
    "create",
    "from",
    "have",
    "into",
    "need",
    "project",
    "should",
    "that",
    "their",
    "this",
    "with",
    "would",
  ]);

  return Array.from(
    new Set(
      input
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((word) => word.length >= 4 && !stopWords.has(word))
        .slice(0, 12),
    ),
  );
}

function toMatchScore(input: {
  reputationScore: number;
  totalSubmissions: number;
  passedSubmissions: number;
  recentSubmissions: number;
  languageHits: number;
  keywordHits: number;
}) {
  const completionRate = input.totalSubmissions > 0
    ? (input.passedSubmissions / input.totalSubmissions) * 100
    : 0;

  const score = Math.min(
    100,
    input.reputationScore * 0.45 +
      completionRate * 0.3 +
      Math.min(input.languageHits, 5) * 4 +
      Math.min(input.keywordHits, 5) * 3 +
      Math.min(input.recentSubmissions, 5) * 2,
  );

  const reasons: string[] = [];
  if (input.languageHits > 0) {
    reasons.push(`${input.languageHits} language-aligned submissions`);
  }
  if (input.keywordHits > 0) {
    reasons.push(`${input.keywordHits} domain-related submissions`);
  }
  if (completionRate >= 70) {
    reasons.push(`Strong completion rate (${completionRate.toFixed(0)}%)`);
  }
  if (input.reputationScore >= 80) {
    reasons.push("High trust score");
  }

  return {
    score: Number(score.toFixed(1)),
    reasons,
  };
}

router.post(
  "/recommendations",
  requireAuth,
  validateBody(freelancerRecommendationBodySchema),
  async (request, response, next) => {
    try {
      if (!request.user) {
        throw new AppError(401, 401, "Unauthorized");
      }
      if (request.user.role !== "client" && request.user.role !== "admin") {
        throw new AppError(403, 403, "Only client/admin roles can request freelancer recommendations");
      }

      const body = request.body as {
        description: string;
        allowed_languages?: string[];
        min_rating?: number;
        limit: number;
      };

      const normalizedLanguages = (body.allowed_languages ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      const keywords = extractKeywords(body.description);
      const minReputation =
        typeof body.min_rating === "number" ? Math.round(body.min_rating * 20) : null;

      const candidates = await dbQuery<{
        id: string;
        name: string | null;
        reputation_score: number;
        total_submissions: number;
        passed_submissions: number;
        disputed_submissions: number;
        recent_submissions: number;
        language_hits: number;
        keyword_hits: number;
      }>(
        `
          SELECT u.id,
                 COALESCE(u.display_name, u.email, CONCAT('Freelancer ', LEFT(u.wallet_address, 6))) AS name,
                 u.reputation_score,
                 COUNT(s.id)::int AS total_submissions,
                 COUNT(*) FILTER (WHERE s.status = 'passed')::int AS passed_submissions,
                 COUNT(*) FILTER (WHERE s.status = 'disputed')::int AS disputed_submissions,
                 COUNT(*) FILTER (WHERE s.submission_received_at >= NOW() - INTERVAL '90 days')::int AS recent_submissions,
                 COUNT(*) FILTER (
                   WHERE $1::text[] IS NOT NULL
                     AND b.id IS NOT NULL
                     AND EXISTS (
                       SELECT 1
                       FROM unnest(b.allowed_languages) AS lang
                       WHERE LOWER(lang) = ANY($1::text[])
                     )
                 )::int AS language_hits,
                 COUNT(*) FILTER (
                   WHERE $2::text[] IS NOT NULL
                     AND b.id IS NOT NULL
                     AND EXISTS (
                       SELECT 1
                       FROM unnest($2::text[]) AS kw
                       WHERE LOWER(COALESCE(b.title, '')) LIKE CONCAT('%', kw, '%')
                          OR LOWER(COALESCE(b.description, '')) LIKE CONCAT('%', kw, '%')
                          OR LOWER(COALESCE(b.acceptance_criteria, '')) LIKE CONCAT('%', kw, '%')
                     )
                 )::int AS keyword_hits
          FROM users u
          LEFT JOIN submissions s ON s.freelancer_id = u.id
          LEFT JOIN bounties b ON b.id = s.bounty_id AND b.deleted_at IS NULL
          WHERE u.role = 'freelancer'
            AND u.deleted_at IS NULL
            AND u.is_banned = FALSE
            AND ($3::int IS NULL OR u.reputation_score >= $3::int)
          GROUP BY u.id, u.display_name, u.email, u.wallet_address, u.reputation_score
          ORDER BY u.reputation_score DESC, passed_submissions DESC, recent_submissions DESC
          LIMIT $4
        `,
        [
          normalizedLanguages.length > 0 ? normalizedLanguages : null,
          keywords.length > 0 ? keywords : null,
          minReputation,
          body.limit,
        ],
      );

      const ranked = candidates.rows
        .map((row) => {
          const match = toMatchScore({
            reputationScore: row.reputation_score,
            totalSubmissions: row.total_submissions,
            passedSubmissions: row.passed_submissions,
            recentSubmissions: row.recent_submissions,
            languageHits: row.language_hits,
            keywordHits: row.keyword_hits,
          });

          return {
            id: row.id,
            name: row.name ?? "Freelancer",
            rating: Number((row.reputation_score / 20).toFixed(2)),
            trustScore: row.reputation_score,
            stats: {
              totalSubmissions: row.total_submissions,
              passedSubmissions: row.passed_submissions,
              disputedSubmissions: row.disputed_submissions,
              recentSubmissions: row.recent_submissions,
            },
            match,
          };
        })
        .sort((a, b) => b.match.score - a.match.score)
        .slice(0, body.limit);

      const freelancerIds = ranked.map((entry) => entry.id);
      const recentWork = freelancerIds.length > 0
        ? await dbQuery<{
            freelancer_id: string;
            bounty_id: string;
            bounty_title: string;
            submission_status: string;
            final_score: number | null;
            submitted_at: string;
          }>(
            `
              SELECT ranked.freelancer_id,
                     ranked.bounty_id,
                     ranked.bounty_title,
                     ranked.submission_status,
                     ranked.final_score,
                     ranked.submitted_at
              FROM (
                SELECT s.freelancer_id,
                       b.id AS bounty_id,
                       b.title AS bounty_title,
                       s.status AS submission_status,
                       s.final_score,
                       s.submission_received_at::text AS submitted_at,
                       ROW_NUMBER() OVER (PARTITION BY s.freelancer_id ORDER BY s.submission_received_at DESC) AS row_num
                FROM submissions s
                JOIN bounties b ON b.id = s.bounty_id
                WHERE s.freelancer_id = ANY($1::uuid[])
                  AND b.deleted_at IS NULL
              ) ranked
              WHERE ranked.row_num <= 2
              ORDER BY ranked.submitted_at DESC
            `,
            [freelancerIds],
          )
        : { rows: [] };

      const recentWorkByFreelancer = new Map<string, Array<{
        bountyId: string;
        title: string;
        status: string;
        finalScore: number | null;
        submittedAt: string;
      }>>();

      for (const row of recentWork.rows) {
        const current = recentWorkByFreelancer.get(row.freelancer_id) ?? [];
        current.push({
          bountyId: row.bounty_id,
          title: row.bounty_title,
          status: row.submission_status,
          finalScore: row.final_score,
          submittedAt: row.submitted_at,
        });
        recentWorkByFreelancer.set(row.freelancer_id, current);
      }

      return response.status(200).json({
        data: ranked.map((entry) => ({
          ...entry,
          recentWork: recentWorkByFreelancer.get(entry.id) ?? [],
        })),
        meta: {
          keywords,
          allowed_languages: normalizedLanguages,
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

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