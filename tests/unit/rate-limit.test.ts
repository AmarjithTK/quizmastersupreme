/**
 * Rate limiter (M14) — in-memory fixed window.
 *
 * Tests the mechanics (window, slip, reset, key derivation). The deliberate
 * limitation — it is per-instance memory, so it guards against bursts, not
 * distributed attacks — is documented in the module, not papered over here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clientKey,
  enforceRateLimit,
  resetRateLimiterForTests,
  RATE_LIMITS,
} from "@/modules/rate-limit";

function req(ip = "203.0.113.7"): Request {
  return new Request("http://localhost/api/x", { headers: { "cf-connecting-ip": ip } });
}

describe("enforceRateLimit", () => {
  beforeEach(resetRateLimiterForTests);

  it("allows a request up to the bucket limit", () => {
    const { limit } = RATE_LIMITS.auth;
    for (let i = 0; i < limit; i++) {
      const r = enforceRateLimit(req(), "auth");
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(limit - 1 - i);
    }
  });

  it("rejects with RATE_LIMITED once the window is exhausted", () => {
    const { limit } = RATE_LIMITS.auth;
    for (let i = 0; i < limit; i++) enforceRateLimit(req(), "auth");
    expect(() => enforceRateLimit(req(), "auth")).toThrowError("Too many requests");
  });

  it("keeps buckets independent — a busy search does not block logins", () => {
    const { limit } = RATE_LIMITS.search;
    for (let i = 0; i < limit; i++) enforceRateLimit(req(), "search");
    // Auth limit was untouched.
    expect(() => enforceRateLimit(req(), "auth")).not.toThrow();
  });

  it("slips the window after it expires", () => {
    const { limit, windowMs } = RATE_LIMITS.auth;
    for (let i = 0; i < limit; i++) enforceRateLimit(req(), "auth");
    vi.setSystemTime(Date.now() + windowMs + 1);
    expect(() => enforceRateLimit(req(), "auth")).not.toThrow();
    vi.useRealTimers();
  });

  it("keys on the client IP, falling back to local without one", () => {
    expect(clientKey(req("9.9.9.9"))).toBe("9.9.9.9");
    expect(clientKey(new Request("http://localhost/x"))).toBe("local");
  });

  it("does not let one IP exhaust another IP's budget", () => {
    const { limit } = RATE_LIMITS.auth;
    for (let i = 0; i < limit; i++) enforceRateLimit(req("1.1.1.1"), "auth");
    expect(() => enforceRateLimit(req("2.2.2.2"), "auth")).not.toThrow();
  });
});