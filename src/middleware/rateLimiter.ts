import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

type KeyGenerator = (request: Request) => string | null;

interface RateLimiterOptions {
  max: number;
  windowMs: number;
  keyGenerator: KeyGenerator;
}

interface RateWindow {
  count: number;
  resetAt: number;
}

const limiterStore = new Map<string, RateWindow>();
const ACCESS_TOKEN_SECRET = process.env.JWT_ACCESS_SECRET ?? "dev-access-secret";
const HACKATHON_MODE = process.env.HACKATHON_MODE === "true";

function resolvePrincipal(request: Request) {
  if (request.user?.userId) {
    return request.user.userId;
  }

  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return null;
  }

  const token = header.slice("Bearer ".length);
  try {
    const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET) as { sub?: string; type?: string };
    if (decoded.type === "access" && decoded.sub) {
      return decoded.sub;
    }
    return null;
  } catch {
    return null;
  }
}

function extractClientIp(request: Request) {
  const forwarded = String(request.headers["x-forwarded-for"] ?? "").trim();
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? request.ip ?? "unknown";
  }
  return request.ip ?? "unknown";
}

export function getGitHubIpRangeKey(request: Request) {
  const ip = extractClientIp(request);
  const cleaned = ip.replace("::ffff:", "");

  if (cleaned.includes(":")) {
    const chunks = cleaned.split(":").slice(0, 4).join(":");
    return `gh-ipv6:${chunks}`;
  }

  const octets = cleaned.split(".");
  if (octets.length !== 4) {
    return `gh:${cleaned}`;
  }

  return `gh:${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

export function createRateLimiter(options: RateLimiterOptions) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (HACKATHON_MODE) {
      return next();
    }

    const key = options.keyGenerator(request);
    if (!key) {
      return next();
    }

    const now = Date.now();
    const current = limiterStore.get(key);

    if (!current || current.resetAt <= now) {
      limiterStore.set(key, {
        count: 1,
        resetAt: now + options.windowMs,
      });
      return next();
    }

    if (current.count >= options.max) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      response.setHeader("Retry-After", String(retryAfter));
      return response.status(429).json({
        error: "Rate limit exceeded",
        code: 429,
        detail: "API-002: Too many requests. Retry later.",
      });
    }

    current.count += 1;
    limiterStore.set(key, current);
    return next();
  };
}

export const perIpRateLimiter = createRateLimiter({
  max: 120,
  windowMs: 60_000,
  keyGenerator: (request) => `ip:${request.ip}`,
});

export const perUserRateLimiter = createRateLimiter({
  max: 20,
  windowMs: 60_000,
  keyGenerator: (request) => {
    const principal = resolvePrincipal(request);
    if (principal) {
      return `user:${principal}`;
    }
    return `ip:${extractClientIp(request)}`;
  },
});

export const authPerIpRateLimiter = createRateLimiter({
  max: 5,
  windowMs: 60_000,
  keyGenerator: (request) => `auth:${extractClientIp(request)}`,
});

export const webhookPerRangeRateLimiter = createRateLimiter({
  max: 500,
  windowMs: 60_000,
  keyGenerator: (request) => getGitHubIpRangeKey(request),
});

export const adminPerUserRateLimiter = createRateLimiter({
  max: 10,
  windowMs: 60_000,
  keyGenerator: (request) => {
    if (request.user?.role === "admin") {
      return `admin:${request.user.userId}`;
    }
    return `admin-ip:${extractClientIp(request)}`;
  },
});
