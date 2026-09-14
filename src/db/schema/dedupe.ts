/**
 * Duplicate-detection state.
 * PLAN.md §13.
 *
 * Vectorize (M12) stores only `vector_id → question_id`. D1 stays the source of
 * truth, so the whole vector index can be deleted and rebuilt from these
 * tables at any time (§2.3).
 */

import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { questions } from "./questions";

export const duplicateFlags = sqliteTable(
  "duplicate_flags",
  {
    id: text("id").primaryKey(),
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    matchedQuestionId: text("matched_question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    layer: text("layer").notNull(),
    similarity: real("similarity").notNull(),
    detail: text("detail"),
    status: text("status").notNull().default("open"),
    resolvedBy: text("resolved_by"),
    resolvedAt: integer("resolved_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("uq_dupflags_pair").on(t.questionId, t.matchedQuestionId, t.layer),
    index("ix_dupflags_status").on(t.status, t.similarity),
    check("ck_dupflags_layer", sql`${t.layer} in ('exact','text','semantic')`),
    check(
      "ck_dupflags_status",
      sql`${t.status} in ('open','confirmed','dismissed','merged')`,
    ),
    check("ck_dupflags_not_self", sql`${t.questionId} <> ${t.matchedQuestionId}`),
  ],
);

export const questionEmbeddings = sqliteTable(
  "question_embeddings",
  {
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    /** Re-embed only when the embedded text actually changes. */
    contentHash: text("content_hash").notNull(),
    vectorizeId: text("vectorize_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.questionId, t.model] })],
);

export type DuplicateFlag = typeof duplicateFlags.$inferSelect;
export type QuestionEmbedding = typeof questionEmbeddings.$inferSelect;
