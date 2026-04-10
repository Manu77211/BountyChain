import { createServer, type Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { Server, type Socket } from "socket.io";
import { dbQuery } from "../../lib/db/client";
import type { UserRole } from "../../lib/db/types";

const ACCESS_TOKEN_SECRET = process.env.JWT_ACCESS_SECRET ?? "dev-access-secret";

export type RealtimeEventName =
  | "bounty:funded"
  | "bounty:accepted"
  | "bounty:ci_running"
  | "bounty:ci_passed"
  | "bounty:ci_failed"
  | "bounty:scoring"
  | "bounty:scored"
  | "bounty:payout_released"
  | "bounty:expired"
  | "bounty:deadline_extended"
  | "bounty:disputed"
  | "dispute:vote_cast"
  | "dispute:resolved"
  | "payout:mismatch_flagged"
  | "validation:opt_in_required"
  | "notification:new";

interface SocketClaims {
  sub: string;
  role: UserRole;
  wallet_address: string;
  session_id: string;
  type: "access";
}

interface AuthenticatedSocketData {
  userId: string;
  role: UserRole;
  walletAddress: string;
  sessionId: string;
}

let ioSingleton: Server | null = null;

export function initializeRealtime(server: HttpServer) {
  const io = new Server(server, {
    cors: {
      origin: (process.env.CORS_ORIGINS ?? "http://localhost:3000")
        .split(",")
        .map((value) => value.trim()),
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      const token = extractToken(socket);
      if (!token) {
        next(new Error("Unauthorized socket connection"));
        return;
      }

      const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET) as SocketClaims;
      if (decoded.type !== "access") {
        next(new Error("Invalid token type"));
        return;
      }

      const session = await dbQuery<{ id: string; wallet_address: string }>(
        `
          SELECT id, wallet_address
          FROM auth_sessions
          WHERE id = $1
            AND user_id = $2
            AND revoked_at IS NULL
            AND expires_at > NOW()
          LIMIT 1
        `,
        [decoded.session_id, decoded.sub],
      );

      if ((session.rowCount ?? 0) === 0) {
        next(new Error("Inactive auth session"));
        return;
      }

      const userData: AuthenticatedSocketData = {
        userId: decoded.sub,
        role: decoded.role,
        walletAddress: decoded.wallet_address,
        sessionId: decoded.session_id,
      };

      socket.data.auth = userData;
      next();
    } catch {
      next(new Error("Unauthorized socket connection"));
    }
  });

  io.on("connection", (socket) => {
    const auth = getSocketAuth(socket);
    if (!auth) {
      socket.emit("disconnect", { reason: "Unauthorized" });
      socket.disconnect(true);
      return;
    }

    socket.join(userRoom(auth.userId));

    socket.on("join:bounty", async (payload: { bounty_id?: string }) => {
      const bountyId = String(payload?.bounty_id ?? "").trim();
      if (!bountyId) {
        return;
      }

      const canJoin = await canAccessBounty(auth.userId, auth.role, bountyId);
      if (!canJoin) {
        return;
      }

      socket.join(bountyRoom(bountyId));
    });

    socket.on("join:arbitration", async (payload: { dispute_id?: string }) => {
      const disputeId = String(payload?.dispute_id ?? "").trim();
      if (!disputeId) {
        return;
      }

      const canJoin = await canAccessDispute(auth.userId, auth.role, disputeId);
      if (!canJoin) {
        return;
      }

      socket.join(arbitrationRoom(disputeId));
    });

    socket.on("sync", async (payload: { bounty_id?: string }) => {
      const bountyId = String(payload?.bounty_id ?? "").trim();
      if (!bountyId) {
        return;
      }
      await syncBountyState(socket, bountyId, auth);
    });

    socket.onAny(async (eventName: string) => {
      if (!eventName.startsWith("sync:")) {
        return;
      }
      const bountyId = eventName.slice("sync:".length).trim();
      if (!bountyId) {
        return;
      }
      await syncBountyState(socket, bountyId, auth);
    });
  });

  ioSingleton = io;
  return io;
}

export function getRealtimeServer() {
  return ioSingleton;
}

export function emitToUser(userId: string, eventName: RealtimeEventName, payload: Record<string, unknown>) {
  ioSingleton?.to(userRoom(userId)).emit(eventName, payload);
}

export function emitToBounty(bountyId: string, eventName: RealtimeEventName, payload: Record<string, unknown>) {
  ioSingleton?.to(bountyRoom(bountyId)).emit(eventName, payload);
}

export function emitToArbitration(
  disputeId: string,
  eventName: RealtimeEventName,
  payload: Record<string, unknown>,
) {
  ioSingleton?.to(arbitrationRoom(disputeId)).emit(eventName, payload);
}

function extractToken(socket: Socket) {
  const authToken = socket.handshake.auth?.token;
  if (typeof authToken === "string" && authToken.trim()) {
    return authToken.trim();
  }

  const authorization = socket.handshake.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  return null;
}

function getSocketAuth(socket: Socket) {
  return socket.data.auth as AuthenticatedSocketData | undefined;
}

function userRoom(userId: string) {
  return `user:${userId}`;
}

function bountyRoom(bountyId: string) {
  return `bounty:${bountyId}`;
}

function arbitrationRoom(disputeId: string) {
  return `arbitration:${disputeId}`;
}

async function canAccessBounty(userId: string, role: UserRole, bountyId: string) {
  if (role === "admin") {
    return true;
  }

  const access = await dbQuery<{ id: string }>(
    `
      SELECT b.id
      FROM bounties b
      LEFT JOIN submissions s ON s.bounty_id = b.id
      WHERE b.id = $1
        AND (
          b.creator_id = $2
          OR s.freelancer_id = $2
        )
      LIMIT 1
    `,
    [bountyId, userId],
  );

  return (access.rowCount ?? 0) > 0;
}

async function canAccessDispute(userId: string, role: UserRole, disputeId: string) {
  if (role === "admin") {
    return true;
  }

  const access = await dbQuery<{ id: string }>(
    `
      SELECT d.id
      FROM disputes d
      JOIN submissions s ON s.id = d.submission_id
      JOIN bounties b ON b.id = s.bounty_id
      LEFT JOIN dispute_votes dv ON dv.dispute_id = d.id AND dv.is_active = TRUE
      WHERE d.id = $1
        AND (
          b.creator_id = $2
          OR s.freelancer_id = $2
          OR dv.arbitrator_id = $2
        )
      LIMIT 1
    `,
    [disputeId, userId],
  );

  return (access.rowCount ?? 0) > 0;
}

async function syncBountyState(socket: Socket, bountyId: string, auth: AuthenticatedSocketData) {
  const canJoin = await canAccessBounty(auth.userId, auth.role, bountyId);
  if (!canJoin) {
    socket.emit("sync:state", {
      bounty_id: bountyId,
      error: "Forbidden",
    });
    return;
  }

  socket.join(bountyRoom(bountyId));

  const bounty = await dbQuery<Record<string, unknown>>(
    `
      SELECT *
      FROM bounties
      WHERE id = $1
      LIMIT 1
    `,
    [bountyId],
  );

  const milestones = await dbQuery<Record<string, unknown>>(
    `
      SELECT *
      FROM milestones
      WHERE bounty_id = $1
      ORDER BY order_index ASC
    `,
    [bountyId],
  );

  const submissions = await dbQuery<Record<string, unknown>>(
    `
      SELECT s.*,
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', p.id,
                   'status', p.status,
                   'expected_amount', p.expected_amount,
                   'actual_amount', p.actual_amount,
                   'tx_id', p.tx_id,
                   'mismatch_flagged', p.mismatch_flagged,
                   'hold_reason', p.hold_reason
                 )
               ) FILTER (WHERE p.id IS NOT NULL),
               '[]'::json
             ) AS payouts
      FROM submissions s
      LEFT JOIN payouts p ON p.submission_id = s.id
      WHERE s.bounty_id = $1
      GROUP BY s.id
      ORDER BY s.updated_at DESC
    `,
    [bountyId],
  );

  const disputes = await dbQuery<Record<string, unknown>>(
    `
      SELECT d.*,
             COALESCE(v.vote_count, 0) AS vote_count
      FROM disputes d
      LEFT JOIN (
        SELECT dispute_id,
               COUNT(*) FILTER (WHERE vote IS NOT NULL AND is_active = TRUE) AS vote_count
        FROM dispute_votes
        GROUP BY dispute_id
      ) v ON v.dispute_id = d.id
      WHERE d.submission_id IN (
        SELECT id FROM submissions WHERE bounty_id = $1
      )
      ORDER BY d.updated_at DESC
    `,
    [bountyId],
  );

  socket.emit("sync:state", {
    bounty_id: bountyId,
    bounty: bounty.rows[0] ?? null,
    milestones: milestones.rows,
    submissions: submissions.rows,
    disputes: disputes.rows,
    synced_at: new Date().toISOString(),
  });
}

export function createRealtimeHttpServer() {
  return createServer();
}
