/**
 * Identity: users + auth sessions.
 * PLAN.md §6.2, §16.1.
 *
 * Authentication is GOOGLE-ONLY (decision D-2). That has a useful side effect:
 * there is no password hashing, so the Workers Free ~10 ms CPU ceiling that
 * PLAN.md §22 R-1 flagged as the auth blocker does not apply. We never run a
 * KDF in the Worker.
 *
 * `passwordHash` is deliberately kept as a NULLABLE column rather than dropped:
 * it costs nothing and leaves the door open for email+password later without a
 * second identity migration.
 */

import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { timestamps } from "./_shared";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    /** Lowercased + trimmed. The unique key we match a Google account against. */
    emailNorm: text("email_norm").notNull().unique(),

    /** Google's stable subject identifier ("sub"). The real identity anchor. */
    googleSub: text("google_sub"),
    avatarUrl: text("avatar_url"),
    emailVerified: integer("email_verified").notNull().default(0),
    authProvider: text("auth_provider").notNull().default("google"),

    /** Unused under Google-only auth. Kept nullable for a future password login. */
    passwordHash: text("password_hash"),

    displayName: text("display_name"),
    role: text("role").notNull().default("user"),
    status: text("status").notNull().default("active"),
    lastLoginAt: integer("last_login_at"),
    ...timestamps,
  },
  (t) => [
    index("ix_users_role").on(t.role),
    // Multiple NULLs are permitted in a SQLite unique index, so users created
    // before Google linking (or by a future provider) do not collide.
    uniqueIndex("ux_users_google_sub").on(t.googleSub),
    check("ck_users_role", sql`${t.role} in ('user','admin')`),
    check("ck_users_status", sql`${t.status} in ('active','suspended')`),
    check("ck_users_auth_provider", sql`${t.authProvider} in ('google','password')`),
    check("ck_users_email_verified", sql`${t.emailVerified} in (0,1)`),
  ],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    /** sha256 of the session token. The raw token exists only in the cookie. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    userAgent: text("user_agent"),
    ipHash: text("ip_hash"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("ix_auth_sessions_user").on(t.userId),
    index("ix_auth_sessions_expires").on(t.expiresAt),
  ],
);

/** Short-lived state for the OAuth authorization-code + PKCE flow. */
export const oauthStates = sqliteTable(
  "oauth_states",
  {
    /** sha256 of the state value, so a leaked DB row cannot forge a callback. */
    id: text("id").primaryKey(),
    /** PKCE code_verifier. Single-use; deleted as soon as the callback runs. */
    codeVerifier: text("code_verifier").notNull(),
    /** Where to send the user after a successful login. */
    redirectTo: text("redirect_to"),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("ix_oauth_states_expires").on(t.expiresAt)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type AuthSession = typeof authSessions.$inferSelect;
export type OAuthState = typeof oauthStates.$inferSelect;
