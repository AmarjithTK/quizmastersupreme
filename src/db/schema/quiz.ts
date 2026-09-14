/**
 * Attempts, answers, and per-user progress.
 * PLAN.md §6.2, §11.
 *
 * The two partial unique indexes here are load-bearing, not decoration:
 *   ux_attempt_active  → makes "one in-progress attempt per user per set" a
 *                        DATABASE invariant. This IS the resume feature (§11.4).
 *   (answers PK)       → makes answer writes idempotent (§2.5).
 */

import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { timestamps } from "./_shared";
import { quizSets } from "./content";
import { questions } from "./questions";

export const quizAttempts = sqliteTable(
  "quiz_attempts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    setId: text("set_id")
      .notNull()
      .references(() => quizSets.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("in_progress"),

    /** JSON array of question ids, FROZEN at start so mid-attempt edits can't change it. */
    questionOrder: text("question_order").notNull(),
    /** JSON map { questionId: [optionKeys] } when options are shuffled. */
    optionOrder: text("option_order"),

    totalQuestions: integer("total_questions").notNull(),
    currentIndex: integer("current_index").notNull().default(0),
    answeredCount: integer("answered_count").notNull().default(0),
    correctCount: integer("correct_count").notNull().default(0),
    wrongCount: integer("wrong_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),

    timeLimitSeconds: integer("time_limit_seconds"),
    /** started_at + limit. AUTHORITATIVE — the client clock cannot extend it (§11.5). */
    serverDeadlineAt: integer("server_deadline_at"),
    timeSpentMs: integer("time_spent_ms").notNull().default(0),

    startedAt: integer("started_at").notNull(),
    lastActivityAt: integer("last_activity_at").notNull(),
    completedAt: integer("completed_at"),
    ...timestamps,
  },
  (t) => [
    // THE RESUME CONSTRAINT.
    uniqueIndex("ux_attempt_active")
      .on(t.userId, t.setId)
      .where(sql`${t.status} = 'in_progress'`),
    index("ix_attempts_user").on(t.userId, t.startedAt),
    index("ix_attempts_set").on(t.setId),
    check(
      "ck_attempts_status",
      sql`${t.status} in ('in_progress','completed','abandoned','expired')`,
    ),
  ],
);

export const quizAttemptAnswers = sqliteTable(
  "quiz_attempt_answers",
  {
    attemptId: text("attempt_id")
      .notNull()
      .references(() => quizAttempts.id, { onDelete: "cascade" }),
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    questionIndex: integer("question_index").notNull(),
    /** NULL = skipped. */
    selectedOptionKey: text("selected_option_key"),
    /** NULL = skipped. */
    isCorrect: integer("is_correct"),
    timeTakenMs: integer("time_taken_ms").notNull().default(0),
    answeredAt: integer("answered_at").notNull(),
    clientSeq: integer("client_seq"),
  },
  (t) => [
    // Composite PK = idempotent answer writes. Re-submitting changes nothing.
    primaryKey({ columns: [t.attemptId, t.questionId] }),
    index("ix_answers_attempt").on(t.attemptId, t.questionIndex),
  ],
);

/** Cross-attempt ledger: "have I seen this question before?" (§8.4, §11.4). */
export const userQuestionSeen = sqliteTable(
  "user_question_seen",
  {
    userId: text("user_id").notNull(),
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    timesSeen: integer("times_seen").notNull().default(1),
    timesCorrect: integer("times_correct").notNull().default(0),
    lastIsCorrect: integer("last_is_correct"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.questionId] }),
    index("ix_uqs_user_recent").on(t.userId, t.lastSeenAt),
  ],
);

/** Denormalized rollup so screen 2 renders 60 cards in one query, not 60 scans. */
export const userSetStats = sqliteTable(
  "user_set_stats",
  {
    userId: text("user_id").notNull(),
    setId: text("set_id")
      .notNull()
      .references(() => quizSets.id, { onDelete: "cascade" }),
    attemptsCount: integer("attempts_count").notNull().default(0),
    completedCount: integer("completed_count").notNull().default(0),
    bestCorrect: integer("best_correct").notNull().default(0),
    bestTotal: integer("best_total").notNull().default(0),
    bestPercent: integer("best_percent"),
    questionsSeen: integer("questions_seen").notNull().default(0),
    lastAttemptAt: integer("last_attempt_at"),
    firstCompletedAt: integer("first_completed_at"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.setId] })],
);

export type QuizAttempt = typeof quizAttempts.$inferSelect;
export type NewQuizAttempt = typeof quizAttempts.$inferInsert;
export type QuizAttemptAnswer = typeof quizAttemptAnswers.$inferSelect;
export type NewQuizAttemptAnswer = typeof quizAttemptAnswers.$inferInsert;
export type UserSetStats = typeof userSetStats.$inferSelect;

export { timestamps };
