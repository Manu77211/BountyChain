import type { NextFunction, Request, Response } from "express";

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

export function createRateLimiter(options: RateLimiterOptions) {
  return (request: Request, response: Response, next: NextFunction) => {
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
  max: 60,
  windowMs: 60_000,
  keyGenerator: (request) => `ip:${request.ip}`,
});

export const perUserRateLimiter = createRateLimiter({
  max: 120,
  windowMs: 60_000,
  keyGenerator: (request) => (request.user ? `user:${request.user.userId}` : null),
});
