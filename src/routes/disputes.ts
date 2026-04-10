import { Router } from "express";
import { z } from "zod";
import { inngest } from "../jobs/aiScoring.job";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { adminPerUserRateLimiter } from "../middleware/rateLimiter";
import { validateBody, validateParams } from "../middleware/validate";
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
    return response.status(200).json(details);
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
