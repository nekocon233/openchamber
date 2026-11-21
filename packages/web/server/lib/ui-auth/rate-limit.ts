import type { Request } from '../shared/http-contracts.js';

interface RateLimitRecord {
  count: number;
  lastAttempt: number;
  lockedUntil?: number;
}

interface RateLimitHeaders {
  limit: number;
  remaining: number;
  reset: number;
}

type RateLimitResult = RateLimitHeaders & (
  { allowed: true } | { allowed: false; retryAfter: number; locked: true }
);

export const hasErrorDetails = (value: unknown): value is { message?: unknown; statusCode?: unknown } => value != null;

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

const RATE_LIMIT_MAX_ATTEMPTS = Number(process.env.OPENCHAMBER_RATE_LIMIT_MAX_ATTEMPTS) || 10;

const RATE_LIMIT_LOCKOUT_MS = 15 * 60 * 1000;

const RATE_LIMIT_CLEANUP_MS = 60 * 60 * 1000;

const RATE_LIMIT_NO_IP_MAX_ATTEMPTS = Number(process.env.OPENCHAMBER_RATE_LIMIT_NO_IP_MAX_ATTEMPTS) || 3;

const loginRateLimiter = new Map<string, RateLimitRecord>();

let rateLimitCleanupTimer: ReturnType<typeof setInterval> | null = null;

const rateLimitLocks = new Map<string, Promise<boolean>>();

const getClientIp = (req: Request) => {
  const ip = req.ip || req.socket?.remoteAddress;
  if (ip) {
    if (ip.startsWith('::ffff:')) {
      return ip.substring(7);
    }
    return ip;
  }
  return null;
};

const getRateLimitKey = (req: Request) => {
  const ip = getClientIp(req);
  if (ip) return ip;
  return 'rate-limit:no-ip';
};

const getRateLimitConfig = (key: string) => {
  if (key === 'rate-limit:no-ip') {
    return {
      maxAttempts: RATE_LIMIT_NO_IP_MAX_ATTEMPTS,
      windowMs: RATE_LIMIT_WINDOW_MS
    };
  }
  return {
    maxAttempts: RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: RATE_LIMIT_WINDOW_MS
  };
};

const acquireRateLimitLock = async (key: string) => {
  const prev = rateLimitLocks.get(key) || Promise.resolve();
  const curr = prev.then(() => rateLimitLocks.delete(key));
  rateLimitLocks.set(key, curr);
  await curr;
};

export const checkRateLimit = async (req: Request): Promise<RateLimitResult> => {
  const key = getRateLimitKey(req);
  await acquireRateLimitLock(key);

  const now = Date.now();
  const { maxAttempts } = getRateLimitConfig(key);

  let record;
  try {
    record = loginRateLimiter.get(key);
  } catch (err) {
      console.error('[RateLimit] Failed to get record', { key, error: hasErrorDetails(err) ? err.message : undefined });
    return {
      allowed: true,
      limit: maxAttempts,
      remaining: maxAttempts,
      reset: Math.ceil((now + RATE_LIMIT_WINDOW_MS) / 1000)
    };
  }

  if (record?.lockedUntil && now < record.lockedUntil) {
    return {
      allowed: false,
      retryAfter: Math.ceil((record.lockedUntil - now) / 1000),
      locked: true,
      limit: maxAttempts,
      remaining: 0,
      reset: Math.ceil(record.lockedUntil / 1000)
    };
  }

  if (record?.lockedUntil && now >= record.lockedUntil) {
    try {
      loginRateLimiter.delete(key);
    } catch (err) {
      console.error('[RateLimit] Failed to delete expired record', { key, error: hasErrorDetails(err) ? err.message : undefined });
    }
  }

  if (!record || now - record.lastAttempt > RATE_LIMIT_WINDOW_MS) {
    return {
      allowed: true,
      limit: maxAttempts,
      remaining: maxAttempts,
      reset: Math.ceil((now + RATE_LIMIT_WINDOW_MS) / 1000)
    };
  }

  if (record.count >= maxAttempts) {
    const lockedUntil = now + RATE_LIMIT_LOCKOUT_MS;
    try {
      loginRateLimiter.set(key, { count: record.count + 1, lastAttempt: now, lockedUntil });
    } catch (err) {
      console.error('[RateLimit] Failed to set lockout', { key, error: hasErrorDetails(err) ? err.message : undefined });
    }
    return {
      allowed: false,
      retryAfter: Math.ceil(RATE_LIMIT_LOCKOUT_MS / 1000),
      locked: true,
      limit: maxAttempts,
      remaining: 0,
      reset: Math.ceil(lockedUntil / 1000)
    };
  }

  const remaining = maxAttempts - record.count;
  const reset = Math.ceil((record.lastAttempt + RATE_LIMIT_WINDOW_MS) / 1000);
  return {
    allowed: true,
    limit: maxAttempts,
    remaining,
    reset
  };
};

export const recordFailedAttempt = async (req: Request) => {
  const key = getRateLimitKey(req);
  await acquireRateLimitLock(key);

  const now = Date.now();
  const record = loginRateLimiter.get(key);

  if (!record || now - record.lastAttempt > RATE_LIMIT_WINDOW_MS) {
    try {
      loginRateLimiter.set(key, { count: 1, lastAttempt: now });
    } catch (err) {
      console.error('[RateLimit] Failed to record attempt', { key, error: hasErrorDetails(err) ? err.message : undefined });
    }
  } else {
    const newCount = record.count + 1;
    try {
      loginRateLimiter.set(key, { count: newCount, lastAttempt: now });
    } catch (err) {
      console.error('[RateLimit] Failed to record attempt', { key, error: hasErrorDetails(err) ? err.message : undefined });
    }
  }
};

export const clearRateLimit = async (req: Request) => {
  const key = getRateLimitKey(req);
  await acquireRateLimitLock(key);

  try {
    loginRateLimiter.delete(key);
  } catch (err) {
    console.error('[RateLimit] Failed to clear', { key, error: hasErrorDetails(err) ? err.message : undefined });
  }
};

const cleanupRateLimitRecords = () => {
  const now = Date.now();
  for (const [key, record] of loginRateLimiter.entries()) {
    const isExpired = record.lockedUntil && now >= record.lockedUntil;
    const isStale = now - record.lastAttempt > RATE_LIMIT_CLEANUP_MS;
    if (isExpired || isStale) {
      try {
        loginRateLimiter.delete(key);
      } catch (err) {
        console.error('[RateLimit] Cleanup failed', { key, error: hasErrorDetails(err) ? err.message : undefined });
      }
    }
  }
};

export const startRateLimitCleanup = () => {
  if (!rateLimitCleanupTimer) {
    rateLimitCleanupTimer = setInterval(cleanupRateLimitRecords, RATE_LIMIT_CLEANUP_MS);
    rateLimitCleanupTimer.unref();
  }
};

export const disposeRateLimitCleanup = () => {
  loginRateLimiter.clear();
  if (!rateLimitCleanupTimer) return;
  clearInterval(rateLimitCleanupTimer);
  rateLimitCleanupTimer = null;
};
