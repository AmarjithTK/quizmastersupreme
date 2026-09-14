/**
 * Session lifecycle: opaque browser token ↔ D1 auth_sessions row.
 *
 * Security notes (PLAN.md §16.1):
 * - The cookie carries a 256-bit random token; the DATABASE stores only
 *   sha256(token), so a leaked `auth_sessions` table cannot be replayed as
 *   cookies.
 * - `HttpOnly` + `SameSite=Lax`; `Secure` is applied automatically except in
 *   local dev (browsers refuse Secure cookies on http://localhost).
 *
 * The session module owns `auth_sessions` ONLY. Resolving a session to its
 * `users` row is `service.ts`'s job, so lookups across the two tables stay in
 * one place (PLAN.md §2.4).
 */

import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { authSessions } from "@/db/schema";
import { randomToken, sha256Hex } from "@/lib/crypto";
import { isDev } from "@/lib/cloudflare/bindings";

export const SESSION_COOKIE_NAME = "qms_session";
/** 30 days of inactivity before a session expires. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

export type SessionMeta = {
  userAgent?: string | null;
  ipHash?: string | null;
};

export async function createSession(
  userId: string,
  meta: SessionMeta = {},
): Promise<{ rawToken: string; expiresAt: number }> {
  const rawToken = randomToken(32);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  await db().insert(authSessions).values({
    id: await sha256Hex(rawToken),
    userId,
    expiresAt,
    lastSeenAt: now,
    userAgent: meta.userAgent ?? null,
    ipHash: meta.ipHash ?? null,
    createdAt: now,
  });

  return { rawToken, expiresAt };
}

/**
 * Resolve a raw token to a user id, enforcing expiry and deleting expired
 * rows on contact. Returns null for unknown or expired tokens.
 */
export async function findSessionUserId(rawToken: string): Promise<string | null> {
  const rows = await db()
    .select({ id: authSessions.id, userId: authSessions.userId, expiresAt: authSessions.expiresAt })
    .from(authSessions)
    .where(eq(authSessions.id, await sha256Hex(rawToken)))
    .limit(1);

  const session = rows[0];
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    await db().delete(authSessions).where(eq(authSessions.id, session.id));
    return null;
  }
  return session.userId;
}

export async function destroySession(rawToken: string): Promise<void> {
  const id = await sha256Hex(rawToken);
  await db().delete(authSessions).where(eq(authSessions.id, id));
}

// ── Cookie helpers ───────────────────────────────────────────────────────────

export function sessionCookie(rawToken: string, expiresAt: number): string {
  const secure = !isDev();
  const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
  return [
    `${SESSION_COOKIE_NAME}=${rawToken}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Extract the raw session token from a Request's Cookie header. */
export function getTokenFromRequest(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${SESSION_COOKIE_NAME}=`)) continue;
    return trimmed.slice(SESSION_COOKIE_NAME.length + 1);
  }
  return null;
}