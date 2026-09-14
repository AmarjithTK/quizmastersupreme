/**
 * Content, depth 1 and 2 ONLY.
 *
 * PLAN.md §2.1 — the tree is exactly:
 *   CATEGORY (depth 1, home grid) → QUIZ SET (depth 2, terminal) → QUESTIONS
 *
 * There is deliberately NO parent_id column here, and a unit test asserts that
 * none is ever added. `group_label` is display-only grouping inside the set
 * grid; it creates no route and no schema depth.
 */

import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { timestamps } from "./_shared";

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    description: text("description"),
    /** lucide-react icon name, validated against an allowlist in the service layer. */
    icon: text("icon"),
    accentColor: text("accent_color"),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status").notNull().default("draft"),
    ...timestamps,
  },
  (t) => [
    index("ix_categories_status_sort").on(t.status, t.sortOrder),
    check("ck_categories_status", sql`${t.status} in ('draft','published','archived')`),
  ],
);

export const quizSets = sqliteTable(
  "quiz_sets",
  {
    id: text("id").primaryKey(),
    /** NOT NULL is what makes depth 3 impossible: a set cannot float or nest. */
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    /** Display-only grouping inside the set grid, e.g. "Kerala State". */
    groupLabel: text("group_label"),
    mode: text("mode").notNull().default("practice"),
    difficulty: text("difficulty").notNull().default("medium"),
    /** NULL = untimed. */
    timeLimitSeconds: integer("time_limit_seconds"),
    /** NULL = serve every attached question. */
    questionLimit: integer("question_limit"),
    shuffleQuestions: integer("shuffle_questions").notNull().default(1),
    shuffleOptions: integer("shuffle_options").notNull().default(0),
    passingPercent: integer("passing_percent"),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status").notNull().default("draft"),
    publishedAt: integer("published_at"),
    ...timestamps,
  },
  (t) => [
    unique("uq_quiz_sets_category_slug").on(t.categoryId, t.slug),
    index("ix_quiz_sets_category").on(t.categoryId, t.status, t.sortOrder),
    index("ix_quiz_sets_status").on(t.status),
    check("ck_quiz_sets_status", sql`${t.status} in ('draft','published','archived')`),
    check("ck_quiz_sets_mode", sql`${t.mode} in ('practice','mock')`),
    check(
      "ck_quiz_sets_difficulty",
      sql`${t.difficulty} in ('easy','medium','hard','expert','mixed')`,
    ),
    check("ck_quiz_sets_shuffle_q", sql`${t.shuffleQuestions} in (0,1)`),
    check("ck_quiz_sets_shuffle_o", sql`${t.shuffleOptions} in (0,1)`),
    check(
      "ck_quiz_sets_passing",
      sql`${t.passingPercent} is null or (${t.passingPercent} between 0 and 100)`,
    ),
  ],
);

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type QuizSet = typeof quizSets.$inferSelect;
export type NewQuizSet = typeof quizSets.$inferInsert;
