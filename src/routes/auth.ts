import { createHash, randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import jwt from "jsonwebtoken";
import { dbQuery } from "../../lib/db/client";
import type { UserRole } from "../../lib/db/types";
import { validateBody } from "../middleware/validate";
import { walletLoginSchema } from "../schemas/auth.schema";
import { screenWalletAndLog } from "../middleware/sanctions";
import { isValidAlgorandAddress, normalizeWalletAddress, verifyWalletSignature } from "../services/wallet";

const router = Router();

const ACCESS_TOKEN_SECRET = process.env.JWT_ACCESS_SECRET ?? "dev-access-secret";
const REFRESH_TOKEN_SECRET = process.env.JWT_REFRESH_SECRET ?? "dev-refresh-secret";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
const REFRESH_COOKIE_NAME = "refresh_token";

router.post("/wallet-login", validateBody(walletLoginSchema), async (request, response, next) => {
  try {
    const walletAddress = normalizeWalletAddress(request.body.wallet_address);
    if (!isValidAlgorandAddress(walletAddress)) {
      return response.status(400).json({
        error: "Invalid wallet",
        code: 400,
        detail: "wallet_address is not a valid Algorand address",
      });
    }

    const verified = verifyWalletSignature({
      walletAddress,
      signedMessage: request.body.signed_message,
      signature: request.body.signature,
    });
    if (!verified) {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "AUTH-002: Signature verification declined",
      });
    }

    const bannedQuery = "SELECT wallet_address FROM banned_wallets WHERE wallet_address = $1 LIMIT 1";
    const bannedResult = await dbQuery<{ wallet_address: string }>(bannedQuery, [walletAddress]);
    if ((bannedResult.rowCount ?? 0) > 0) {
      return response.status(403).json({
        error: "Wallet blocked",
        code: 403,
        detail: "Wallet is in banned list",
      });
    }

    const user = await upsertWalletUser(walletAddress, request.body.role ?? "freelancer");
    const sanctionCheck = await screenWalletAndLog(walletAddress, "auth.wallet-login", user.id);
    if (sanctionCheck.flagged) {
      return response.status(403).json({
        error: "Sanctions blocked",
        code: 403,
        detail: "Wallet flagged by sanctions screening",
      });
    }

    const sessionId = randomUUID();
    const accessToken = signAccessToken({
      userId: user.id,
      role: user.role,
      walletAddress,
      sessionId,
    });
    const refreshToken = signRefreshToken({
      userId: user.id,
      role: user.role,
      walletAddress,
      sessionId,
    });

    const insertSessionSql = `
      INSERT INTO auth_sessions (id, user_id, wallet_address, refresh_token_hash, expires_at)
      VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days')
    `;
    await dbQuery(insertSessionSql, [sessionId, user.id, walletAddress, hashToken(refreshToken)]);

    setRefreshCookie(response, refreshToken);
    return response.status(200).json({
      access_token: accessToken,
      expires_in: ACCESS_TTL_SECONDS,
      user,
      wallet_linked: Boolean(user.wallet_address),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/refresh", async (request, response, next) => {
  try {
    const refreshToken = request.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    if (!refreshToken) {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "AUTH-001: Refresh token missing",
      });
    }

    const decoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET) as RefreshClaims;
    if (decoded.type !== "refresh") {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "Refresh token type mismatch",
      });
    }

    const sessionSql = `
      SELECT s.id, s.user_id, s.wallet_address, s.refresh_token_hash, u.role
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = $1
        AND s.user_id = $2
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
        AND u.deleted_at IS NULL
      LIMIT 1
    `;

    const session = await dbQuery<{
      id: string;
      user_id: string;
      wallet_address: string;
      refresh_token_hash: string;
      role: UserRole;
    }>(sessionSql, [decoded.session_id, decoded.sub]);

    if ((session.rowCount ?? 0) === 0) {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "Refresh session not active",
      });
    }

    const activeSession = session.rows[0];
    const candidateHash = hashToken(refreshToken);
    if (activeSession.refresh_token_hash !== candidateHash) {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "Refresh token invalidated",
      });
    }

    if (activeSession.wallet_address !== decoded.wallet_address) {
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "AUTH-003: Session is bound to a different wallet",
      });
    }

    const nextAccess = signAccessToken({
      userId: activeSession.user_id,
      role: activeSession.role,
      walletAddress: activeSession.wallet_address,
      sessionId: activeSession.id,
    });

    const nextRefresh = signRefreshToken({
      userId: activeSession.user_id,
      role: activeSession.role,
      walletAddress: activeSession.wallet_address,
      sessionId: activeSession.id,
    });

    const updateSessionSql = `
      UPDATE auth_sessions
      SET refresh_token_hash = $1,
          expires_at = NOW() + INTERVAL '7 days'
      WHERE id = $2
    `;
    await dbQuery(updateSessionSql, [hashToken(nextRefresh), activeSession.id]);

    setRefreshCookie(response, nextRefresh);
    return response.status(200).json({
      access_token: nextAccess,
      expires_in: ACCESS_TTL_SECONDS,
      detail: "AUTH-001: Token refreshed",
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/disconnect", async (request, response, next) => {
  try {
    const refreshToken = request.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    if (refreshToken) {
      try {
        const decoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET) as RefreshClaims;
        await dbQuery("UPDATE auth_sessions SET revoked_at = NOW() WHERE id = $1", [decoded.session_id]);
      } catch {
        // Ignore invalid refresh tokens during disconnect.
      }
    }

    response.clearCookie(REFRESH_COOKIE_NAME, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
    });

    return response.status(200).json({
      disconnected: true,
    });
  } catch (error) {
    return next(error);
  }
});

interface SignTokenInput {
  userId: string;
  role: UserRole;
  walletAddress: string;
  sessionId: string;
}

interface RefreshClaims {
  sub: string;
  role: UserRole;
  wallet_address: string;
  session_id: string;
  type: "refresh";
}

function signAccessToken(input: SignTokenInput) {
  return jwt.sign(
    {
      role: input.role,
      wallet_address: input.walletAddress,
      session_id: input.sessionId,
      type: "access",
    },
    ACCESS_TOKEN_SECRET,
    { subject: input.userId, expiresIn: ACCESS_TTL_SECONDS },
  );
}

function signRefreshToken(input: SignTokenInput) {
  return jwt.sign(
    {
      role: input.role,
      wallet_address: input.walletAddress,
      session_id: input.sessionId,
      type: "refresh",
    },
    REFRESH_TOKEN_SECRET,
    { subject: input.userId, expiresIn: REFRESH_TTL_SECONDS },
  );
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function setRefreshCookie(response: Response, refreshToken: string) {
  response.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: REFRESH_TTL_SECONDS * 1000,
    path: "/",
  });
}

async function upsertWalletUser(walletAddress: string, role: UserRole) {
  const insertSql = `
    INSERT INTO users (wallet_address, role)
    VALUES ($1, $2)
    ON CONFLICT (wallet_address)
    DO UPDATE SET wallet_address = EXCLUDED.wallet_address
    RETURNING id, email, wallet_address, role, reputation_score, is_sanctions_flagged, is_banned
  `;
  const inserted = await dbQuery(insertSql, [walletAddress, role]);
  return inserted.rows[0];
}

export default router;
