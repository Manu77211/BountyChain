import { Router } from "express";
import { z } from "zod";
import { dbQuery } from "../../lib/db/client";
import { requireAuth } from "../middleware/auth";
import { validateBody } from "../middleware/validate";

const router = Router();

const updateProfileSchema = z.object({
  email: z.string().email().optional(),
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
