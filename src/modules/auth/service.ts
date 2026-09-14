/**
 * Auth service — the only module that touches both `users` and `auth_sessions`.
 *
 * Owns: upserting a Google identity into `users`, resolving sessions to users,
 * and the admin authorization checks every protected route calls.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { newId, users, type User } from "@/db/schema";
import { forbidden, unauthorized } from "@/lib/errors";
import { authConfig } from "./config";
import type { GoogleIdentity } from "./google";
import { findSessionUserId, getTokenFromRequest } from "./session";

// ── Identity upsert ──────────────────────────────────────────────────────────

export async function upsertUserFromGoogle(
  identity: GoogleIdentity,
  adminEmails: string[] = authConfig().adminEmails,
): Promise<User> {
  const database = db();
  const now = Date.now();
  const isBootstrapAdmin = adminEmails.includes(identity.email);

  // 1) Match on Google's stable subject id first.
  let existing = (
    await database.select().from(users).where(eq(users.googleSub, identity.sub)).limit(1)
  )[0];

  // 2) Fall back to email — covers rows created before Google linking existed.
  if (!existing) {
    existing = (
      await database
        .select()
        .from(users)
        .where(eq(users.emailNorm, identity.email))
        .limit(1)
    )[0];
  }

  if (existing) {
    if (existing.status === "suspended") {
      throw unauthorized("This account has been suspended.");
    }
    // Never demote an existing admin, but promote when the email is on the list.
    const role = existing.role === "admin" || isBootstrapAdmin ? "admin" : "user";

    await database
      .update(users)
      .set({
        googleSub: existing.googleSub ?? identity.sub,
        avatarUrl: identity.picture ?? existing.avatarUrl,
        displayName: identity.name ?? existing.displayName,
        emailVerified: 1,
        role,
        lastLoginAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, existing.id));

    return (await database.select().from(users).where(eq(users.id, existing.id)))[0]!;
  }

  const row: User = {
    id: newId(),
    email: identity.email,
    emailNorm: identity.email,
    googleSub: identity.sub,
    avatarUrl: identity.picture,
    emailVerified: 1,
    authProvider: "google",
    passwordHash: null,
    displayName: identity.name,
    role: isBootstrapAdmin ? "admin" : "user",
    status: "active",
    lastLoginAt: now,
    createdAt: now,
    updatedAt: now,
  };

  await database.insert(users).values(row);
  return row;
}

// ── Session → user resolution ────────────────────────────────────────────────

export async function getSessionUserFromToken(rawToken: string): Promise<User | null> {
  const userId = await findSessionUserId(rawToken);
  if (!userId) return null;

  const row = (await db().select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!row || row.status !== "active") return null;
  return row;
}

export async function getCurrentUserFromRequest(request: Request): Promise<User | null> {
  const token = getTokenFromRequest(request);
  if (!token) return null;
  return getSessionUserFromToken(token);
}

// ── Guards ───────────────────────────────────────────────────────────────────

export async function requireUser(request: Request): Promise<User> {
  const user = await getCurrentUserFromRequest(request);
  if (!user) throw unauthorized();
  return user;
}

export async function requireAdmin(request: Request): Promise<User> {
  const user = await requireUser(request);
  if (user.role !== "admin") throw forbidden();
  return user;
}

/** The user shape safe to send to the browser. Nothing else leaves the server. */
export function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    role: user.role,
  };
}

/**
 * Allow only same-origin absolute paths as post-login redirect targets.
 * Blocks open-redirect vectors like `?redirect=https://evil.example` and
 * protocol-relative `//evil.example`.
 */
export function sanitizeRedirect(value: string | null, origin: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const parsed = new URL(value, origin);
    if (parsed.origin !== origin) return "/";
    return parsed.pathname + parsed.search;
  } catch {
    return "/";
  }
}