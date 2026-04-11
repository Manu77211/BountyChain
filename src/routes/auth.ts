import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { Router, type Response } from "express";
import jwt from "jsonwebtoken";
import { dbQuery } from "../../lib/db/client";
import type { UserRole } from "../../lib/db/types";
import { requireAuth } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { loginSchema, registerSchema, walletLoginSchema } from "../schemas/auth.schema";
import { screenWalletAndLog } from "../middleware/sanctions";
import { isValidAlgorandAddress, normalizeWalletAddress, verifyWalletSignature } from "../services/wallet";

const router = Router();

const ACCESS_TOKEN_SECRET = process.env.JWT_ACCESS_SECRET ?? "dev-access-secret";
const REFRESH_TOKEN_SECRET = process.env.JWT_REFRESH_SECRET ?? "dev-refresh-secret";

const ACCESS_TTL_SECONDS = process.env.HACKATHON_MODE === "true" ? 7 * 24 * 60 * 60 : 15 * 60;
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
const HACKATHON_MODE = process.env.HACKATHON_MODE === "true";
const REFRESH_COOKIE_NAME = "refresh_token";
const ACCESS_COOKIE_NAME = "access_token";
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const ALGORAND_BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const loginAttemptStore = new Map<string, { count: number; lockUntil: number }>();

function getAttemptKey(ip: string) {
  return `ip:${ip}`;
}

function checkLockout(key: string) {
  const state = loginAttemptStore.get(key);
  if (!state) {
    return null;
  }

  const now = Date.now();
  if (state.lockUntil > now) {
    return Math.ceil((state.lockUntil - now) / 1000);
  }

  loginAttemptStore.delete(key);
  return null;
}

function recordFailedAttempt(key: string) {
  const current = loginAttemptStore.get(key) ?? { count: 0, lockUntil: 0 };
  const nextCount = current.count + 1;
  const lockUntil = nextCount >= MAX_LOGIN_ATTEMPTS ? Date.now() + LOGIN_LOCKOUT_MS : 0;
  loginAttemptStore.set(key, { count: nextCount, lockUntil });
}

function clearFailedAttempts(key: string) {
  loginAttemptStore.delete(key);
}

function toClientRole(role: UserRole): "CLIENT" | "FREELANCER" {
  return role === "client" ? "CLIENT" : "FREELANCER";
}

function toDbRole(role: "CLIENT" | "FREELANCER" | "client" | "freelancer"): UserRole {
  return role.toUpperCase() === "CLIENT" ? "client" : "freelancer";
}

function isDbConnectionError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "").toUpperCase()
    : "";

  return (
    message.includes("database") ||
    message.includes("enotfound") ||
    message.includes("econnrefused") ||
    message.includes("timed out") ||
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT"
  );
}

function toClientRoleFromAny(role: string): "CLIENT" | "FREELANCER" | "ADMIN" | "ARBITRATOR" {
  const normalized = role.toLowerCase();
  if (normalized === "admin") {
    return "ADMIN";
  }
  if (normalized === "arbitrator") {
    return "ARBITRATOR";
  }
  if (normalized === "client") {
    return "CLIENT";
  }
  return "FREELANCER";
}

function generateSyntheticWalletAddress() {
  const bytes = randomBytes(58);
  return Array.from(bytes, (value) => ALGORAND_BASE32[value % ALGORAND_BASE32.length]).join("");
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password: string, encodedHash: string | null) {
  if (!encodedHash || !encodedHash.includes(":")) {
    return false;
  }

  const [salt, expectedHex] = encodedHash.split(":");
  if (!salt || !expectedHex) {
    return false;
  }

  const actual = Buffer.from(scryptSync(password, salt, 64).toString("hex"), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
}

function formatAuthPayload(input: {
  accessToken: string;
  user: {
    id: string;
    email: string | null;
    wallet_address: string;
    role: UserRole;
    reputation_score: number;
    display_name: string | null;
  };
}) {
  return {
    token: input.accessToken,
    user: {
      id: input.user.id,
      name: input.user.display_name ?? input.user.email ?? "BountyEscrow User",
      email: input.user.email ?? "",
      role: toClientRole(input.user.role),
      skills: [],
      rating: Number((input.user.reputation_score / 20).toFixed(2)),
      trustScore: input.user.reputation_score,
      experience: "",
      portfolio: [],
    },
  };
}

router.get("/nonce", (request, response) => {
  const walletAddress = String(request.query.wallet_address ?? "").trim();
  const nonce = randomUUID();
  const timestamp = new Date().toISOString();
  const normalizedWallet = walletAddress ? normalizeWalletAddress(walletAddress) : "";
  const message = normalizedWallet
    ? `BountyEscrow wallet auth\nNonce: ${nonce}\nAddress: ${normalizedWallet}\nTimestamp: ${timestamp}`
    : `BountyEscrow wallet auth\nNonce: ${nonce}\nTimestamp: ${timestamp}`;

  return response.status(200).json({
    nonce,
    message,
    expires_in: 300,
  });
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

    const result = await dbQuery<{
      id: string;
      email: string | null;
      wallet_address: string;
      role: UserRole;
      reputation_score: number;
      display_name: string | null;
    }>(
      `
        SELECT id, email, wallet_address, role, reputation_score, display_name
        FROM users
        WHERE id = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [request.user.userId],
    );

    if ((result.rowCount ?? 0) === 0) {
      return response.status(404).json({
        error: "Not found",
        code: 404,
        detail: "User not found",
      });
    }

    const user = result.rows[0];
    return response.status(200).json({
      user: {
        id: user.id,
        name: user.display_name ?? user.email ?? "BountyEscrow User",
        email: user.email ?? "",
        role: toClientRole(user.role),
        skills: [],
        rating: Number((user.reputation_score / 20).toFixed(2)),
        trustScore: user.reputation_score,
        experience: "",
        portfolio: [],
        wallet_address: user.wallet_address,
      },
    });
  } catch (error) {
    if (HACKATHON_MODE && isDbConnectionError(error) && request.user) {
      return response.status(200).json({
        user: {
          id: request.user.userId,
          name: "BountyEscrow User",
          email: "",
          role: toClientRoleFromAny(request.user.role),
          skills: [],
          rating: 5,
          trustScore: 100,
          experience: "",
          portfolio: [],
          wallet_address: request.user.walletAddress,
        },
      });
    }
    return next(error);
  }
});

router.post("/register", validateBody(registerSchema), async (request, response, next) => {
  try {
    const email = String(request.body.email).trim().toLowerCase();
    const name = String(request.body.name).trim();
    const role = toDbRole(request.body.role as "CLIENT" | "FREELANCER");
    const passwordHash = hashPassword(String(request.body.password));

    const existingUser = await dbQuery<{ id: string }>(
      "SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL LIMIT 1",
      [email],
    );

    if ((existingUser.rowCount ?? 0) > 0) {
      return response.status(409).json({
        error: "Conflict",
        code: 409,
        detail: "AUTH-006: Account already exists for this email",
      });
    }

    const walletAddress = generateSyntheticWalletAddress();
    const insertedUser = await dbQuery<{
      id: string;
      email: string | null;
      wallet_address: string;
      role: UserRole;
      reputation_score: number;
      display_name: string | null;
    }>(
      `
        INSERT INTO users (email, wallet_address, role, display_name, password_hash)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, email, wallet_address, role, reputation_score, display_name
      `,
      [email, walletAddress, role, name, passwordHash],
    );

    const user = insertedUser.rows[0];
    const sanctionCheck = await screenWalletAndLog(user.wallet_address, "auth.register", user.id);
    if (sanctionCheck.flagged) {
      await dbQuery(
        "UPDATE users SET is_sanctions_flagged = TRUE, updated_at = NOW() WHERE id = $1",
        [user.id],
      );
      return response.status(403).json({
        error: "Forbidden",
        code: 403,
        detail: "CL-001: User requires compliance review",
      });
    }

    const sessionId = randomUUID();
    const accessToken = signAccessToken({
      userId: user.id,
      role: user.role,
      walletAddress: user.wallet_address,
      sessionId,
    });
    const refreshToken = signRefreshToken({
      userId: user.id,
      role: user.role,
      walletAddress: user.wallet_address,
      sessionId,
    });

    await dbQuery(
      `
        INSERT INTO auth_sessions (id, user_id, wallet_address, refresh_token_hash, expires_at)
        VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days')
      `,
      [sessionId, user.id, user.wallet_address, hashToken(refreshToken)],
    );

  setAccessCookie(response, accessToken);
    setRefreshCookie(response, refreshToken);
    return response.status(201).json(formatAuthPayload({ accessToken, user }));
  } catch (error) {
    return next(error);
  }
});

router.post("/login", validateBody(loginSchema), async (request, response, next) => {
  try {
    const email = String(request.body.email).trim().toLowerCase();
    const password = String(request.body.password);
    const attemptKey = getAttemptKey(request.ip ?? "unknown");
    const retryAfter = checkLockout(attemptKey);

    if (retryAfter) {
      response.setHeader("Retry-After", String(retryAfter));
      return response.status(429).json({
        error: "Rate limit exceeded",
        code: 429,
        detail: "AUTH-007: Too many failed login attempts. Retry later.",
      });
    }

    const userResult = await dbQuery<{
      id: string;
      email: string | null;
      wallet_address: string;
      role: UserRole;
      reputation_score: number;
      is_sanctions_flagged: boolean;
      is_banned: boolean;
      password_hash: string | null;
      display_name: string | null;
    }>(
      `
        SELECT id,
               email,
               wallet_address,
               role,
               reputation_score,
               is_sanctions_flagged,
               is_banned,
               password_hash,
               display_name
        FROM users
        WHERE email = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [email],
    );

    if ((userResult.rowCount ?? 0) === 0) {
      recordFailedAttempt(attemptKey);
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "AUTH-004: Invalid email or password",
      });
    }

    const user = userResult.rows[0];
    const validPassword = verifyPassword(password, user.password_hash);
    if (!validPassword) {
      recordFailedAttempt(attemptKey);
      return response.status(401).json({
        error: "Unauthorized",
        code: 401,
        detail: "AUTH-004: Invalid email or password",
      });
    }

    if (user.is_banned || user.is_sanctions_flagged) {
      return response.status(403).json({
        error: "Forbidden",
        code: 403,
        detail: "AUTH-005: Account is restricted",
      });
    }

    clearFailedAttempts(attemptKey);

    const sessionId = randomUUID();
    const accessToken = signAccessToken({
      userId: user.id,
      role: user.role,
      walletAddress: user.wallet_address,
      sessionId,
    });
    const refreshToken = signRefreshToken({
      userId: user.id,
      role: user.role,
      walletAddress: user.wallet_address,
      sessionId,
    });

    await dbQuery(
      `
        INSERT INTO auth_sessions (id, user_id, wallet_address, refresh_token_hash, expires_at)
        VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days')
      `,
      [sessionId, user.id, user.wallet_address, hashToken(refreshToken)],
    );

  setAccessCookie(response, accessToken);
    setRefreshCookie(response, refreshToken);
    return response.status(200).json(formatAuthPayload({ accessToken, user }));
  } catch (error) {
    return next(error);
  }
});

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

  setAccessCookie(response, accessToken);
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

  setAccessCookie(response, nextAccess);
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
    response.clearCookie(ACCESS_COOKIE_NAME, {
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

function setAccessCookie(response: Response, accessToken: string) {
  response.cookie(ACCESS_COOKIE_NAME, accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: ACCESS_TTL_SECONDS * 1000,
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
