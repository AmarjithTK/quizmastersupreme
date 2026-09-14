/**
 * Shared column fragments and helpers.
 *
 * All timestamps in this schema are Unix epoch MILLISECONDS stored as INTEGER.
 * PLAN.md §6.2: integers sort and index correctly and avoid timezone ambiguity.
 */

import { integer } from "drizzle-orm/sqlite-core";

export const timestamps = {
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
};

export function nowMs(): number {
  return Date.now();
}

/** Ids are application-generated (crypto.randomUUID or a prefixed random id). */
export function newId(): string {
  return crypto.randomUUID();
}

// ── Shared union types ──────────────────────────────────────────────────────

export const USER_ROLES = ["user", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["active", "suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const PUBLISH_STATES = ["draft", "published", "archived"] as const;
export type PublishState = (typeof PUBLISH_STATES)[number];

export const DIFFICULTIES = ["easy", "medium", "hard", "expert"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const SET_DIFFICULTIES = ["easy", "medium", "hard", "expert", "mixed"] as const;
export type SetDifficulty = (typeof SET_DIFFICULTIES)[number];

/** PLAN.md §2.2 — the only path from AI output to published content is human review. */
export const QUESTION_STATUSES = [
  "ai_draft",
  "draft",
  "review",
  "approved",
  "published",
  "rejected",
  "duplicate",
  "archived",
] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const QUESTION_ORIGINS = ["manual", "ai", "import", "seed"] as const;
export type QuestionOrigin = (typeof QUESTION_ORIGINS)[number];

export const OPTION_KEYS = ["A", "B", "C", "D", "E"] as const;
export type OptionKey = (typeof OPTION_KEYS)[number];

export const ATTEMPT_STATUSES = ["in_progress", "completed", "abandoned", "expired"] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
