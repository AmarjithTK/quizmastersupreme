/**
 * Rate limiting (M14).
 *
 * Deliberately IN-MEMORY: a Workers instance is a short-lived process, and the
 * alternatives have real costs. A D1-backed counter would survive restarts but
 * adds a write to the hot path of every protected request (D1 is not free).
 * KV counters would need a KV binding and eventual-consistency caveats. An
 * in-memory fixed window is honest, zero-binding, and the right guard against
 * the thing it actually protects against: a single surprise burst. It is NOT
 * a defence against a distributed attack — say so in docs, not code.
 *
 * Windows are per (bucket, key). Keys are client IPs from the platform's
 * `CF-Connecting-IP` header; without one (local dev) they fall back to
 * "local", which keeps the dev loop identical to production.
 */

import { rateLimited } from "@/lib/errors";

export type RateLimitBucket = "auth" | "attempts" | "answer" | "admin" | "search";

export const RATE_LIMITS: Record<RateLimitBucket, { limit: number; windowMs: number }> = {
  /** OIDC endpoints hit one or two times per human login; bursty but harmless. */
  auth: { limit: 30, windowMs: 15 * 60 * 1000 },
  /** Starting quizzes, including the double-start guard. */
  attempts: { limit: 30, windowMs: 60 * 1000 },
  /** Answer submissions: one per question, plus idempotent retries. */
  answer: { limit: 60, windowMs: 60 * 1000 },
  /** Generation steps are expensive (a model call); a runaway click loop must stall fast. */
  admin: { limit: 30, windowMs: 60 * 1000 },
  /** Public search. */
  search: { limit: 60, windowMs: 60 * 1000 },
};

type Window = { startedAt: number; count: number };

/** bucket → key → window. Pruned lazily on each access. */
const windows = new Map<string, Map<string, Window>>();
const MAX_WINDOWS = 10_000;

function prune(): void {
  if (windows.size < MAX_WINDOWS) return;
  const now = Date.now();
  for (const [bucket, keys] of windows) {
    for (const [key, window] of keys) {
      if (now - window.startedAt >= RATE_LIMITS[bucket as RateLimitBucket]?.windowMs) {
        keys.delete(key);
      }
    }
    if (keys.size === 0) windows.delete(bucket);
  }
}

export function clientKey(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || "local";
}

/**
 * Enforce the bucket's limit for this request's key. Throws `ApiError`
 * RATE_LIMITED when exceeded; otherwise counts the hit and returns the
 * remaining budget for the `ratelimit-remaining` header.
 */
export function enforceRateLimit(
  request: Request,
  bucket: RateLimitBucket,
): { allowed: true; remaining: number; resetInMs: number } {
  const { limit, windowMs } = RATE_LIMITS[bucket];
  const now = Date.now();

  prune();

  let keys = windows.get(bucket);
  if (!keys) {
    keys = new Map();
    windows.set(bucket, keys);
  }

  const key = clientKey(request);
  const window = keys.get(key);
  if (!window || now - window.startedAt >= windowMs) {
    keys.set(key, { startedAt: now, count: 1 });
    return { allowed: true, remaining: limit - 1, resetInMs: windowMs };
  }

  if (window.count >= limit) {
    throw rateLimited(`Too many requests. Try again shortly.`);
  }

  window.count += 1;
  return { allowed: true, remaining: limit - window.count, resetInMs: window.startedAt + windowMs - now };
}

export { rateLimited };

/** Test seam: forget every window (used between tests, never shipped). */
export function resetRateLimiterForTests(): void {
  windows.clear();
}