import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { dbQuery } from "../../lib/db/client";
import type { UserRole } from "../../lib/db/types";

const ACCESS_TOKEN_SECRET = process.env.JWT_ACCESS_SECRET ?? "dev-access-secret";

export interface AccessTokenClaims {
  sub: string;
  role: UserRole;
  wallet_address: string;
  session_id: string;
  type: "access";
}

export async function requireAuth(request: Request, response: Response, next: NextFunction) {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "Missing bearer token",
      });
    }

    const token = authHeader.slice("Bearer ".length);
    const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET) as AccessTokenClaims;

    if (decoded.type !== "access") {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "Invalid access token type",
      });
    }

    const walletFromHeader = String(request.headers["x-wallet-address"] ?? "").trim().toUpperCase();
    if (walletFromHeader && walletFromHeader !== decoded.wallet_address) {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "AUTH-003: Session is bound to a different wallet",
      });
    }

    const sessionQuery = `
      SELECT id, wallet_address
      FROM auth_sessions
      WHERE id = $1
        AND user_id = $2
        AND revoked_at IS NULL
        AND expires_at > NOW()
      LIMIT 1
    `;
    const sessionResult = await dbQuery<{ id: string; wallet_address: string }>(sessionQuery, [decoded.session_id, decoded.sub]);
    if (sessionResult.rowCount === 0) {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "Session is not active",
      });
    }

    if (sessionResult.rows[0].wallet_address !== decoded.wallet_address) {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "AUTH-003: Session wallet binding mismatch",
      });
    }

    request.user = {
      userId: decoded.sub,
      role: decoded.role,
      walletAddress: decoded.wallet_address,
      sessionId: decoded.session_id,
    };
    return next();
  } catch {
    return response.status(401).json({
      error: "Unauthorized",
      code: 401,
      detail: "Invalid or expired token",
    });
  }
}
