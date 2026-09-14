/**
 * Auth module invariants against real D1 (the same `auth_sessions`,
 * `oauth_states` and `users` tables the app runs on).
 *
 * Uses the setDbForTests seam so the ACTUAL service functions — not their
 * internals — are exercised. No Google network is touched: verifyIdToken's
 * network path is covered separately in tests/unit/google-jwt.test.ts with a
 * locally generated keypair.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbForTests } from "@/db/client";
import * as schema from "@/db/schema";
import { sha256Hex } from "@/lib/crypto";
import {
  consumeOAuthState,
  createOAuthState,
  createSession,
  destroySession,
  findSessionUserId,
  OAuthStateError,
  upsertUserFromGoogle,
  type GoogleIdentity,
} from "@/modules/auth";

let proxy: { env: { DB: D1Database }; dispose: () => Promise<void> } | null = null;

function identity(overrides: Partial<GoogleIdentity> = {}): GoogleIdentity {
  return {
    sub: "google-111",
    email: "test.signer@example.com",
    emailVerified: true,
    name: "Test Signer",
    picture: null,
    ...overrides,
  };
}

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: "wrangler.jsonc",
    persist: { path: ".tooling/test-state" },
  });
  setDbForTests(drizzle(proxy.env.DB, { schema }));
});

afterAll(async () => {
  await proxy?.dispose();
  proxy = null;
  setDbForTests(null);
});

// ── Sessions ─────────────────────────────────────────────────────────────────

describe("session lifecycle", () => {
  it("creates a session that resolves to its user", async () => {
    const user = await upsertUserFromGoogle(
      identity({ sub: "s-1", email: "session.user@example.com" }),
      [],
    );
    const { rawToken } = await createSession(user.id, { userAgent: "vitest" });

    expect(await findSessionUserId(rawToken)).toBe(user.id);

    await destroySession(rawToken);
    expect(await findSessionUserId(rawToken)).toBeNull();
  });

  it("treats an unknown token as not signed in", async () => {
    expect(await findSessionUserId("definitely-not-a-token")).toBeNull();
  });
});

describe("session expiry", () => {
  it("refuses and removes an expired session", async () => {
    const user = await upsertUserFromGoogle(
      identity({ sub: "s-2", email: "expired.user@example.com" }),
      [],
    );
    const { rawToken } = await createSession(user.id);
    const hashed = await sha256Hex(rawToken);

    await db()
      .update(schema.authSessions)
      .set({ expiresAt: Date.now() - 60_000 })
      .where(eq(schema.authSessions.id, hashed))
      .run();

    expect(await findSessionUserId(rawToken)).toBeNull();
    expect(
      (await db().select().from(schema.authSessions).where(eq(schema.authSessions.id, hashed))).length,
    ).toBe(0);
  });
});

// ── OAuth state (single use) ─────────────────────────────────────────────────

describe("oauth state", () => {
  it("consumes a state exactly once", async () => {
    const { state, codeVerifier, codeChallenge } = await createOAuthState("/account");
    expect(codeChallenge.length).toBe(43);

    const consumed = await consumeOAuthState(state);
    expect(consumed.codeVerifier).toBe(codeVerifier);
    expect(consumed.redirectTo).toBe("/account");

    await expect(consumeOAuthState(state)).rejects.toBeInstanceOf(OAuthStateError);
  });

  it("rejects an unknown state as invalid", async () => {
    await expect(consumeOAuthState("not-a-real-state")).rejects.toBeInstanceOf(OAuthStateError);
  });
});

// ── Identity upsert ──────────────────────────────────────────────────────────

describe("upsertUserFromGoogle", () => {
  it("creates a first-time user with the user role", async () => {
    const user = await upsertUserFromGoogle(
      identity({ sub: "s-3", email: "fresh@example.com" }),
      [],
    );
    expect(user.role).toBe("user");
    expect(user.googleSub).toBe("s-3");
    expect(user.emailNorm).toBe("fresh@example.com");
  });

  it("grants admin to a bootstrap email, and never demotes afterwards", async () => {
    const admins = ["boss@example.com"];

    const first = await upsertUserFromGoogle(
      identity({ sub: "s-4", email: "boss@example.com" }),
      admins,
    );
    expect(first.role).toBe("admin");

    // The same person logs in again even if they are later removed from the list.
    const again = await upsertUserFromGoogle(
      identity({ sub: "s-4", email: "boss@example.com" }),
      [],
    );
    expect(again.role).toBe("admin");

    const rows = await db().select().from(schema.users).where(eq(schema.users.googleSub, "s-4"));
    expect(rows).toHaveLength(1);
  });

  it("links an existing email-only account when the sub is new", async () => {
    await db()
      .insert(schema.users)
      .values({
        id: "user_legacy",
        email: "legacy@example.com",
        emailNorm: "legacy@example.com",
        googleSub: null,
        passwordHash: null,
        displayName: "Legacy",
        role: "user",
        status: "active",
        authProvider: "google",
        emailVerified: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();

    const linked = await upsertUserFromGoogle(
      identity({ sub: "s-5", email: "legacy@example.com" }),
      [],
    );

    expect(linked.id).toBe("user_legacy");
    expect(linked.googleSub).toBe("s-5");

    const rows = await db()
      .select()
      .from(schema.users)
      .where(eq(schema.users.emailNorm, "legacy@example.com"));
    expect(rows).toHaveLength(1);
  });

  it("refuses to sign in a suspended account", async () => {
    await upsertUserFromGoogle(identity({ sub: "s-6", email: "suspend.me@example.com" }), []);
    await db()
      .update(schema.users)
      .set({ status: "suspended" })
      .where(eq(schema.users.emailNorm, "suspend.me@example.com"))
      .run();

    await expect(
      upsertUserFromGoogle(identity({ sub: "s-6", email: "suspend.me@example.com" }), []),
    ).rejects.toThrow(/suspended/);
  });
});