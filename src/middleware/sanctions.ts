import type { NextFunction, Request, Response } from "express";
import { dbQuery } from "../../lib/db/client";

interface SanctionsCheckResult {
  flagged: boolean;
  source: "banned_wallets" | "users.is_sanctions_flagged" | "none";
}

export async function screenWalletAndLog(
  walletAddress: string,
  routeName: string,
  userId: string | null,
): Promise<SanctionsCheckResult> {
  const normalizedWallet = walletAddress.trim().toUpperCase();

  const banned = await dbQuery<{ wallet_address: string }>(
    "SELECT wallet_address FROM banned_wallets WHERE wallet_address = $1 LIMIT 1",
    [normalizedWallet],
  );

  let result: SanctionsCheckResult = { flagged: false, source: "none" };
  if ((banned.rowCount ?? 0) > 0) {
    result = { flagged: true, source: "banned_wallets" };
  } else if (userId) {
    const userFlag = await dbQuery<{ id: string }>(
      "SELECT id FROM users WHERE id = $1 AND is_sanctions_flagged = TRUE LIMIT 1",
      [userId],
    );
    if ((userFlag.rowCount ?? 0) > 0) {
      result = { flagged: true, source: "users.is_sanctions_flagged" };
    }
  }

  const auditSql = `
    INSERT INTO sanctions_screenings (wallet_address, user_id, route_name, is_flagged, source, details)
    VALUES ($1, $2, $3, $4, $5, jsonb_build_object('request_time', NOW()))
  `;
  await dbQuery(auditSql, [normalizedWallet, userId, routeName, result.flagged, result.source]);
  return result;
}

export function sanctionsMiddleware(routeName: string) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      if (!request.user) {
        return response.status(401).json({
          error: "Unauthorized",
          code: 401,
          detail: "Login required",
        });
      }

      const screening = await screenWalletAndLog(
        request.user.walletAddress,
        routeName,
        request.user.userId,
      );

      if (screening.flagged) {
        return response.status(403).json({
          error: "Sanctions blocked",
          code: 403,
          detail: "Wallet sanctions check failed",
        });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}
