/**
 * AI generation jobs and their candidate questions.
 * PLAN.md §12.
 *
 * HARD RULE (§2.2): nothing in this module writes to `questions`. Candidates
 * become questions only through `modules/questions.createQuestion()`, after a
 * human approves them. There is no auto-approve path.
 */

import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { categories, quizSets } from "./content";
import { questions } from "./questions";

export const aiGenerationJobs = sqliteTable(
  "ai_generation_jobs",
  {
    id: text("id").primaryKey(),
    createdBy: text("created_by").notNull(),
    targetCategoryId: text("target_category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    targetSetId: text("target_set_id").references(() => quizSets.id, { onDelete: "set null" }),

    /** The admin's natural-language instruction. */
    brief: text("brief").notNull(),
    topic: text("topic").notNull(),
    /** JSON array. */
    subtopics: text("subtopics"),
    difficulty: text("difficulty"),
    requestedCount: integer("requested_count").notNull(),
    /** JSON array. */
    avoidTopics: text("avoid_topics"),

    /**
     * OpenRouter provider routing (M14+). JSON arrays of provider slugs.
     * `only` = allow-list; `order` = priority. Emptied = OpenRouter default
     * routing. See provider.only / provider.order in the OpenRouter docs.
     */
    providerOnly: text("provider_only"),
    providerOrder: text("provider_order"),

    provider: text("provider").notNull().default("openrouter"),
    model: text("model").notNull(),
    temperature: real("temperature"),
    promptVersion: text("prompt_version").notNull(),

    /** Exactly what was sent to the model. Non-negotiable for cost attribution. */
    coverageDigest: text("coverage_digest"),
    coverageTokens: integer("coverage_tokens"),
    includeExamples: integer("include_examples").notNull().default(0),

    status: text("status").notNull().default("queued"),
    producedCount: integer("produced_count").notNull().default(0),
    validCount: integer("valid_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),

    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    costUsd: real("cost_usd"),
    durationMs: integer("duration_ms"),
    /** R2 object key holding the untouched model output (M10+). */
    rawResponseKey: text("raw_response_key"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),

    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("ix_jobs_status").on(t.status, t.createdAt),
    index("ix_jobs_creator").on(t.createdBy, t.createdAt),
    check(
      "ck_jobs_status",
      sql`${t.status} in ('queued','running','succeeded','partial','failed','cancelled')`,
    ),
  ],
);

export const aiCandidates = sqliteTable(
  "ai_candidates",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => aiGenerationJobs.id, { onDelete: "cascade" }),
    batchIndex: integer("batch_index"),

    stem: text("stem").notNull(),
    /** JSON: [{ key, body }] */
    optionsJson: text("options_json").notNull(),
    correctOptionKey: text("correct_option_key").notNull(),
    explanation: text("explanation"),
    backstory: text("backstory"),
    difficulty: text("difficulty"),
    topic: text("topic"),
    tags: text("tags"),

    validationStatus: text("validation_status").notNull().default("pending"),
    /** JSON array of readable reasons — invalid candidates are surfaced, never dropped. */
    validationErrors: text("validation_errors"),

    dedupeStatus: text("dedupe_status").notNull().default("pending"),
    dedupeLayer: text("dedupe_layer"),
    dedupeBestMatchId: text("dedupe_best_match_id").references(() => questions.id, {
      onDelete: "set null",
    }),
    dedupeSimilarity: real("dedupe_similarity"),
    dedupeDetail: text("dedupe_detail"),

    normalizedHash: text("normalized_hash"),
    simhash: text("simhash"),

    reviewStatus: text("review_status").notNull().default("pending"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: integer("reviewed_at"),
    reviewNote: text("review_note"),
    promotedQuestionId: text("promoted_question_id").references(() => questions.id, {
      onDelete: "set null",
    }),

    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("ix_candidates_job").on(t.jobId, t.reviewStatus),
    index("ix_candidates_review").on(t.reviewStatus, t.createdAt),
    check("ck_candidates_validation", sql`${t.validationStatus} in ('pending','valid','invalid')`),
    check(
      "ck_candidates_dedupe",
      sql`${t.dedupeStatus} in ('pending','clean','exact_dup','near_dup','semantic_dup','error')`,
    ),
    check(
      "ck_candidates_review",
      sql`${t.reviewStatus} in ('pending','approved','rejected','merged','deferred')`,
    ),
  ],
);

export type AiGenerationJob = typeof aiGenerationJobs.$inferSelect;
export type NewAiGenerationJob = typeof aiGenerationJobs.$inferInsert;
export type AiCandidate = typeof aiCandidates.$inferSelect;
export type NewAiCandidate = typeof aiCandidates.$inferInsert;
