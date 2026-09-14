/**
 * Questions, their options, and set membership.
 * PLAN.md §6.2, §13.
 *
 * NOTE ON A DELIBERATE OMISSION: `questions.generation_job_id` is a plain text
 * column with no FK constraint. A real FK would require importing ai.ts here,
 * while ai.ts already imports this file — a module cycle that breaks
 * drizzle-kit. Integrity is maintained by `modules/ai` writing through
 * `modules/questions`, never by raw insert (PLAN.md §2.4).
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { nowMs, timestamps } from "./_shared";
import { quizSets } from "./content";

export const questions = sqliteTable(
  "questions",
  {
    id: text("id").primaryKey(),
    stem: text("stem").notNull(),
    stemFormat: text("stem_format").notNull().default("markdown"),
    /** Short "why" — one or two lines. */
    explanation: text("explanation"),
    /** The rich long-form panel rendered by <BackstoryRenderer />. */
    backstory: text("backstory"),
    backstoryFormat: text("backstory_format").notNull().default("markdown"),
    difficulty: text("difficulty").notNull().default("medium"),
    topic: text("topic"),
    /** JSON array of strings. */
    tags: text("tags"),
    year: integer("year"),
    source: text("source"),
    sourceUrl: text("source_url"),
    examBody: text("exam_body"),
    language: text("language").notNull().default("en"),
    status: text("status").notNull().default("draft"),

    // ── Dedupe support (PLAN.md §13) ──────────────────────────────────────
    /** sha256 of the normalized stem. Layer 1. */
    normalizedHash: text("normalized_hash").notNull(),
    /** 64-bit simhash as 16 hex chars. Layer 2 prefilter. */
    simhash: text("simhash"),
    /** sha256 of normalized stem + sorted normalized options. Layer 1b. */
    contentHash: text("content_hash").notNull(),

    // ── Provenance ────────────────────────────────────────────────────────
    origin: text("origin").notNull().default("manual"),
    createdBy: text("created_by"),
    generationJobId: text("generation_job_id"),
    approvedBy: text("approved_by"),
    approvedAt: integer("approved_at"),

    ...timestamps,
  },
  (t) => [
    index("ix_questions_status").on(t.status),
    index("ix_questions_topic").on(t.topic, t.difficulty),
    index("ix_questions_normalized_hash").on(t.normalizedHash),
    index("ix_questions_content_hash").on(t.contentHash),
    index("ix_questions_generation_job").on(t.generationJobId),
    check(
      "ck_questions_status",
      sql`${t.status} in ('ai_draft','draft','review','approved','published','rejected','duplicate','archived')`,
    ),
    check("ck_questions_difficulty", sql`${t.difficulty} in ('easy','medium','hard','expert')`),
    check("ck_questions_origin", sql`${t.origin} in ('manual','ai','import','seed')`),
    check("ck_questions_stem_format", sql`${t.stemFormat} in ('plain','markdown')`),
    check("ck_questions_backstory_format", sql`${t.backstoryFormat} in ('plain','markdown')`),
  ],
);

export const questionOptions = sqliteTable(
  "question_options",
  {
    id: text("id").primaryKey(),
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    optionKey: text("option_key").notNull(),
    body: text("body").notNull(),
    isCorrect: integer("is_correct").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    unique("uq_question_options_key").on(t.questionId, t.optionKey),
    index("ix_question_options_question").on(t.questionId, t.sortOrder),
    check("ck_question_options_key", sql`${t.optionKey} in ('A','B','C','D','E')`),
    check("ck_question_options_correct", sql`${t.isCorrect} in (0,1)`),
    // Enforce at most ONE correct option per question, in the database.
    // PLAN.md §6.4 / test #11.
    uniqueIndex("ux_question_options_single_correct")
      .on(t.questionId)
      .where(sql`${t.isCorrect} = 1`),
  ],
);

export const questionSetQuestions = sqliteTable(
  "question_set_questions",
  {
    setId: text("set_id")
      .notNull()
      .references(() => quizSets.id, { onDelete: "cascade" }),
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    addedAt: integer("added_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.setId, t.questionId] }),
    index("ix_qsq_set_order").on(t.setId, t.sortOrder),
    index("ix_qsq_question").on(t.questionId),
  ],
);

export type Question = typeof questions.$inferSelect;
export type NewQuestion = typeof questions.$inferInsert;
export type QuestionOption = typeof questionOptions.$inferSelect;
export type NewQuestionOption = typeof questionOptions.$inferInsert;
export type QuestionSetQuestion = typeof questionSetQuestions.$inferSelect;

export { nowMs };
