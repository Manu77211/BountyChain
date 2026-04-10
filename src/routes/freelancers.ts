import { Router } from "express";
import { dbQuery } from "../../lib/db/client";
import { validateQuery } from "../middleware/validate";
import { freelancerListQuerySchema } from "../schemas/freelancer.schema";

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

export default router;