import { Router } from "express";
import { z } from "zod";
import { dbQuery } from "../../lib/db/client";
import { inngest } from "../jobs/aiScoring.job";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { adminPerUserRateLimiter } from "../middleware/rateLimiter";
import { validateBody, validateParams, validateQuery } from "../middleware/validate";
import {
  adminBanWallet,
  castDisputeVote,
  challengeArbitrator,
  getDisputeDetails,
  openDispute,
} from "../services/dispute.service";

const router = Router();

const idParamSchema = z.object({
  id: z.string().uuid("id must be UUID"),
});

const openDisputeSchema = z.object({
  submission_id: z.string().uuid(),
  reason: z.string().trim().min(100),
  dispute_type: z.enum([
    "score_unfair",
    "quality_low",
    "requirement_mismatch",
    "fraud",
    "non_delivery",
  ]),
});

const voteSchema = z.object({
  vote: z.enum(["freelancer_wins", "client_wins", "split"]),
  justification: z.string().trim().min(50),
});

const challengeSchema = z.object({
  arbitrator_id: z.string().uuid(),
  justification: z.string().trim().min(50),
});

const banWalletSchema = z.object({
  wallet_address: z.string().trim().min(58).max(58),
  reason: z.string().trim().min(10),
  mfa_token: z.string().trim().min(6),
});

const listDisputesQuerySchema = z.object({
  scope: z.enum(["my", "arbitrator"]).optional(),
  status: z.string().trim().min(1).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

router.get("/disputes", requireAuth, validateQuery(listDisputesQuerySchema), async (request, response, next) => {
  try {
    if (!request.user) {
      throw new AppError(401, 401, "Unauthorized");
    }

    const query = request.query as unknown as {
      scope?: "my" | "arbitrator";
      status?: string;
      limit: number;
    };

    const params: Array<string | number> = [request.user.userId];
    const where: string[] = [];

    if (request.user.role !== "admin") {
      if (query.scope === "arbitrator") {
        where.push(`EXISTS (
          SELECT 1
          FROM dispute_votes dv_scope
          WHERE dv_scope.dispute_id = d.id
            AND dv_scope.arbitrator_id = $1
            AND dv_scope.is_active = TRUE
        )`);
      } else if (query.scope === "my") {
        where.push("(b.creator_id = $1 OR s.freelancer_id = $1)");
      } else {
        where.push(`(
          b.creator_id = $1
          OR s.freelancer_id = $1
          OR EXISTS (
            SELECT 1
            FROM dispute_votes dv_scope
            WHERE dv_scope.dispute_id = d.id
              AND dv_scope.arbitrator_id = $1
              AND dv_scope.is_active = TRUE
          )
        )`);
      }
    }

    if (query.status) {
      params.push(query.status);
      where.push(`d.status::text = $${params.length}`);
    }

    params.push(query.limit);

    const disputes = await dbQuery<{
      id: string;
      bounty_title: string;
      dispute_type: string;
      status: string;
      raised_at: string;
      your_role: "client" | "freelancer" | "arbitrator" | "observer";
      pending_vote: boolean;
      votes_in: number;
      total_votes: number;
    }>(
      `
        SELECT d.id,
               b.title AS bounty_title,
               d.dispute_type::text AS dispute_type,
               d.status::text AS status,
               d.raised_at::text AS raised_at,
               CASE
                 WHEN b.creator_id = $1 THEN 'client'
                 WHEN s.freelancer_id = $1 THEN 'freelancer'
                 WHEN EXISTS (
                   SELECT 1
                   FROM dispute_votes dv_role
                   WHERE dv_role.dispute_id = d.id
                     AND dv_role.arbitrator_id = $1
                     AND dv_role.is_active = TRUE
                 ) THEN 'arbitrator'
                 ELSE 'observer'
               END AS your_role,
               EXISTS (
                 SELECT 1
                 FROM dispute_votes dv_pending
                 WHERE dv_pending.dispute_id = d.id
                   AND dv_pending.arbitrator_id = $1
                   AND dv_pending.is_active = TRUE
                   AND dv_pending.vote IS NULL
               ) AS pending_vote,
               (
                 SELECT COUNT(*)::int
                 FROM dispute_votes dv_in
                 WHERE dv_in.dispute_id = d.id
                   AND dv_in.is_active = TRUE
                   AND dv_in.vote IS NOT NULL
               ) AS votes_in,
               (
                 SELECT COUNT(*)::int
                 FROM dispute_votes dv_total
                 WHERE dv_total.dispute_id = d.id
                   AND dv_total.is_active = TRUE
               ) AS total_votes
        FROM disputes d
        JOIN submissions s ON s.id = d.submission_id
        JOIN bounties b ON b.id = s.bounty_id
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY d.raised_at DESC
        LIMIT $${params.length}
      `,
      params,
    );

    return response.status(200).json({
      data: disputes.rows,
    });
  } catch (error) {
    return next(toDisputeAppError(error));
  }
});

router.post("/disputes", requireAuth, validateBody(openDisputeSchema), async (request, response, next) => {
  try {
    if (!request.user) {
      throw new AppError(401, 401, "Unauthorized");
    }

    const io = request.app.get("io") as
      | {
          to?: (room: string) => { emit: (event: string, payload: unknown) => void };
          emit?: (event: string, payload: unknown) => void;
        }
      | undefined;

    const result = await openDispute(
      request.body,
      request.user.userId,
      {
        send: async (eventName, data) => {
          await inngest.send({ name: eventName, data });
        },
      },
      {
        emitToUsers: async (userIds, eventName, payload) => {
          for (const userId of [...new Set(userIds)]) {
            io?.to?.(`user:${userId}`)?.emit(eventName, payload);
          }
          io?.emit?.(eventName, payload);
        },
      },
    );

    return response.status(201).json({
      dispute_id: result.dispute_id,
      arbitrators: result.arbitrators,
    });
  } catch (error) {
    return next(toDisputeAppError(error));
  }
});

router.get("/disputes/:id", requireAuth, validateParams(idParamSchema), async (request, response, next) => {
  try {
    if (!request.user) {
      throw new AppError(401, 401, "Unauthorized");
    }

    const details = await getDisputeDetails(request.params.id, request.user.userId, request.user.role);

    const voteProgress = await dbQuery<{ total_votes: number; votes_in: number }>(
      `
        SELECT COUNT(*) FILTER (WHERE is_active = TRUE)::int AS total_votes,
               COUNT(*) FILTER (WHERE is_active = TRUE AND vote IS NOT NULL)::int AS votes_in
        FROM dispute_votes
        WHERE dispute_id = $1
      `,
      [request.params.id],
    );

    const viewerAssignment = await dbQuery<{
      is_active: boolean;
      is_challenged: boolean;
      vote: string | null;
    }>(
      `
        SELECT is_active,
               is_challenged,
               vote::text
        FROM dispute_votes
        WHERE dispute_id = $1
          AND arbitrator_id = $2
        ORDER BY assigned_at DESC
        LIMIT 1
      `,
      [request.params.id, request.user.userId],
    );

    const parties = await dbQuery<{ client_id: string; freelancer_id: string }>(
      `
        SELECT b.creator_id AS client_id,
               s.freelancer_id
        FROM disputes d
        JOIN submissions s ON s.id = d.submission_id
        JOIN bounties b ON b.id = s.bounty_id
        WHERE d.id = $1
        LIMIT 1
      `,
      [request.params.id],
    );

    const challengeUsage = await dbQuery<{ challenged_by: string }>(
      `
        SELECT challenged_by
        FROM dispute_votes
        WHERE dispute_id = $1
          AND challenged_by IS NOT NULL
      `,
      [request.params.id],
    );

    const clientId = parties.rows[0]?.client_id ?? null;
    const freelancerId = parties.rows[0]?.freelancer_id ?? null;
    const challengedBy = new Set(challengeUsage.rows.map((row) => row.challenged_by));

    return response.status(200).json({
      ...details,
      meta: {
        vote_progress: {
          total_votes: voteProgress.rows[0]?.total_votes ?? 0,
          votes_in: voteProgress.rows[0]?.votes_in ?? 0,
        },
        viewer_assignment_status:
          (viewerAssignment.rowCount ?? 0) === 0
            ? "unassigned"
            : viewerAssignment.rows[0].is_active
              ? "active"
              : viewerAssignment.rows[0].is_challenged
                ? "challenged"
                : "inactive",
        viewer_has_voted: (viewerAssignment.rowCount ?? 0) > 0 && Boolean(viewerAssignment.rows[0].vote),
        challenge_usage: {
          client_used: clientId ? challengedBy.has(clientId) : false,
          freelancer_used: freelancerId ? challengedBy.has(freelancerId) : false,
        },
      },
    });
  } catch (error) {
    return next(toDisputeAppError(error));
  }
});

router.get("/disputes/:id/activity", requireAuth, validateParams(idParamSchema), async (request, response, next) => {
  try {
    if (!request.user) {
      throw new AppError(401, 401, "Unauthorized");
    }

    await getDisputeDetails(request.params.id, request.user.userId, request.user.role);

    const dispute = await dbQuery<{
      id: string;
      raised_at: string;
      resolved_at: string | null;
      outcome: string | null;
      status: string;
      raised_by: string;
    }>(
      `
        SELECT id,
               raised_at::text,
               resolved_at::text,
               outcome::text,
               status::text,
               raised_by
        FROM disputes
        WHERE id = $1
        LIMIT 1
      `,
      [request.params.id],
    );

    const votes = await dbQuery<{
      arbitrator_id: string;
      vote: string | null;
      justification: string | null;
      is_active: boolean;
      is_challenged: boolean;
      assigned_at: string;
      replaced_at: string | null;
      voted_at: string;
    }>(
      `
        SELECT arbitrator_id,
               vote::text,
               justification,
               is_active,
               is_challenged,
               assigned_at::text,
               replaced_at::text,
               voted_at::text
        FROM dispute_votes
        WHERE dispute_id = $1
        ORDER BY assigned_at ASC
      `,
      [request.params.id],
    );

    if ((dispute.rowCount ?? 0) === 0) {
      throw new AppError(404, 404, "Dispute not found");
    }

    const activeVotes = votes.rows.filter((row) => row.is_active);
    const allVoted = activeVotes.length > 0 && activeVotes.every((row) => Boolean(row.vote));

    const timeline: Array<{ id: string; label: string; at: string; detail?: string }> = [
      {
        id: `${request.params.id}:opened`,
        label: "Dispute opened",
        at: dispute.rows[0].raised_at,
      },
    ];

    if (votes.rows.length > 0) {
      timeline.push({
        id: `${request.params.id}:assigned`,
        label: "Arbitrators assigned",
        at: votes.rows[0].assigned_at,
        detail: `${activeVotes.length} active arbitrators`,
      });
    }

    votes.rows
      .filter((row) => row.is_challenged && row.replaced_at)
      .forEach((row, index) => {
        timeline.push({
          id: `${request.params.id}:challenged:${index}`,
          label: "Arbitrator challenged and replaced",
          at: String(row.replaced_at),
          detail: "DS-003",
        });
      });

    activeVotes
      .filter((row) => row.vote)
      .forEach((row, index) => {
        timeline.push({
          id: `${request.params.id}:vote:${index}`,
          label: allVoted ? `Vote cast (${row.vote})` : "Vote cast",
          at: row.voted_at,
          detail: allVoted ? row.justification ?? undefined : "Anonymous until all votes are in",
        });
      });

    if (dispute.rows[0].resolved_at) {
      timeline.push({
        id: `${request.params.id}:resolved`,
        label: "Dispute resolved",
        at: dispute.rows[0].resolved_at,
        detail: dispute.rows[0].outcome ?? undefined,
      });
    }

    timeline.sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime());

    return response.status(200).json({
      data: timeline,
      vote_progress: {
        votes_in: activeVotes.filter((row) => Boolean(row.vote)).length,
        total_votes: activeVotes.length,
      },
    });
  } catch (error) {
    return next(toDisputeAppError(error));
  }
});

router.post(
  "/disputes/:id/vote",
  requireAuth,
  validateParams(idParamSchema),
  validateBody(voteSchema),
  async (request, response, next) => {
    try {
      if (!request.user) {
        throw new AppError(401, 401, "Unauthorized");
      }

      const result = await castDisputeVote(
        {
          dispute_id: request.params.id,
          vote: request.body.vote,
          justification: request.body.justification,
        },
        request.user.userId,
        {
          send: async (eventName, data) => {
            await inngest.send({ name: eventName, data });
          },
        },
      );

      return response.status(200).json(result);
    } catch (error) {
      return next(toDisputeAppError(error));
    }
  },
);

router.post(
  "/disputes/:id/challenge-arbitrator",
  requireAuth,
  validateParams(idParamSchema),
  validateBody(challengeSchema),
  async (request, response, next) => {
    try {
      if (!request.user) {
        throw new AppError(401, 401, "Unauthorized");
      }

      const io = request.app.get("io") as
        | {
            to?: (room: string) => { emit: (event: string, payload: unknown) => void };
            emit?: (event: string, payload: unknown) => void;
          }
        | undefined;

      const result = await challengeArbitrator(
        {
          dispute_id: request.params.id,
          arbitrator_id: request.body.arbitrator_id,
          justification: request.body.justification,
        },
        request.user.userId,
        {
          send: async (eventName, data) => {
            await inngest.send({ name: eventName, data });
          },
        },
        {
          emitToUsers: async (userIds, eventName, payload) => {
            for (const userId of [...new Set(userIds)]) {
              io?.to?.(`user:${userId}`)?.emit(eventName, payload);
            }
            io?.emit?.(eventName, payload);
          },
        },
      );

      return response.status(200).json(result);
    } catch (error) {
      return next(toDisputeAppError(error));
    }
  },
);

router.post(
  "/admin/ban-wallet",
  requireAuth,
  adminPerUserRateLimiter,
  validateBody(banWalletSchema),
  async (request, response, next) => {
    try {
      if (!request.user) {
        throw new AppError(401, 401, "Unauthorized");
      }

      const result = await adminBanWallet(
        request.body,
        {
          user_id: request.user.userId,
          role: request.user.role,
        },
        {
          send: async (eventName, data) => {
            await inngest.send({ name: eventName, data });
          },
        },
      );

      return response.status(200).json(result);
    } catch (error) {
      return next(toDisputeAppError(error));
    }
  },
);

function toDisputeAppError(error: unknown) {
  if (error instanceof AppError) {
    return error;
  }

  const message = error instanceof Error ? error.message : "Unexpected dispute failure";

  if (message.includes("not found")) {
    return new AppError(404, 404, message);
  }

  if (message.includes("Forbidden") || message.includes("role required") || message.includes("can challenge")) {
    return new AppError(403, 403, message);
  }

  if (
    message.includes("DS-") ||
    message.includes("SC-") ||
    message.includes("RT-") ||
    message.includes("window") ||
    message.includes("state") ||
    message.includes("MFA") ||
    message.includes("assigned")
  ) {
    return new AppError(409, 409, message);
  }

  return new AppError(500, 500, message);
}

export default router;
