/**
 * Identity: users + auth sessions.
 * PLAN.md §6.2, §16.1.
 */

import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { USER_ROLES, USER_STATUSES, timestamps } from "./_shared";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    /** Lowercased + trimmed. The unique key we actually authenticate against. */
    emailNorm: text("email_norm").notNull().unique(),
    /** Self-describing PHC-style string: pbkdf2-sha256$iterations$salt$hash */
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name"),
    role: text("role").notNull().default("user"),
    status: text("status").notNull().default("active"),
    lastLoginAt: integer("last_login_at"),
    ...timestamps,
  },
  (t) => [
    index("ix_users_role").on(t.role),
    check("ck_users_role", sql`${t.role} in ('user','admin')`),
    check("ck_users_status", sql`${t.status} in ('active','suspended')`),
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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type AuthSession = typeof authSessions.$inferSelect;

// Re-export the unions so `.check()` strings above stay honest at the type level.
export { USER_ROLES, USER_STATUSES };
