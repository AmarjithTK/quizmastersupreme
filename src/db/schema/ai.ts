/**
 * AI generation jobs and their working set of candidates.
 * REVAMP-PLAN.md §3 / §5.
 *
 * FLOW: a job calls the model in bounded rounds (one call per request) until it
 * has `requested_count` FRESH questions — duplicates are filtered out against
 * the whole bank as they arrive, and a backfill round asks for the shortfall.
 * The survivors are stored in `ai_candidates` as a plain working set, and the
 * batch screen either rejects individual rows or commits the kept set straight
 * into the question bank (`status = 'active'`, immediately playable).
 *
 * There is no candidate state machine any more: `rejected` is a boolean the
 * reviewer toggles, and everything else is either stored or was never stored.
 */

import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { categories, quizSets } from "./content";

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
    /** Who/what the questions are for (audience or exam). Optional. */
    target: text("target"),
    /** Authoritative references the model must stay within. Optional. */
    sources: text("sources"),
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

    /** The Q Set the whole approved batch was committed to (batch flow). */
    committedSetId: text("committed_set_id"),
    committedAt: integer("committed_at"),

    provider: text("provider").notNull().default("openrouter"),
    model: text("model").notNull(),
    temperature: real("temperature"),
    promptVersion: text("prompt_version").notNull(),

    /** Exactly what was sent to the model. Non-negotiable for cost attribution. */
    coverageDigest: text("coverage_digest"),
    coverageTokens: integer("coverage_tokens"),
    includeExamples: integer("include_examples").notNull().default(0),

    status: text("status").notNull().default("queued"),
    /** Fresh questions produced so far (the working-set size). */
    producedCount: integer("produced_count").notNull().default(0),
    /** Same as produced for the revamp; kept for the UI's existing columns. */
    validCount: integer("valid_count").notNull().default(0),
    /** Duplicates auto-filtered against the bank (never stored). */
    duplicateCount: integer("duplicate_count").notNull().default(0),
    /** Backfill rounds already run (one model call each). */
    backfillRound: integer("backfill_round").notNull().default(0),
    /** Duplicates dropped by the insert-time bank check as well. */
    duplicateSkipped: integer("duplicate_skipped").notNull().default(0),

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
    /** Position in the job's output, so batch order is stable. */
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

    /**
     * The reviewer's decision. Defaults to 1 for anything the dedupe funnel
     * flagged, so a duplicate arrives rejected-by-default but visible and
     * overridable. 0 = eligible to commit.
     */
    rejected: integer("rejected").notNull().default(0),

    // ── Why it was flagged (0006) ─────────────────────────────────────────
    /** 'clean' | 'exact_dup' | 'near_dup' | 'possible_dup'. App-validated. */
    dedupeStatus: text("dedupe_status").notNull().default("clean"),
    /** The bank question this duplicates, when the match is in the bank. */
    dedupeMatchedQuestionId: text("dedupe_matched_question_id"),
    /** Snapshot of the matched stem (bank question OR an earlier batch mate). */
    dedupeMatchedStem: text("dedupe_matched_stem"),
    dedupeSimilarity: real("dedupe_similarity"),
    /** Human-readable explanation shown in the review UI. */
    dedupeReason: text("dedupe_reason"),

    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("ix_candidates_job").on(t.jobId, t.rejected),
    index("ix_candidates_created").on(t.createdAt),
    check("ck_candidates_correct_key", sql`${t.correctOptionKey} in ('A','B','C','D','E')`),
    check("ck_candidates_rejected", sql`${t.rejected} in (0,1)`),
  ],
);

export type AiGenerationJob = typeof aiGenerationJobs.$inferSelect;
export type NewAiGenerationJob = typeof aiGenerationJobs.$inferInsert;
export type AiCandidate = typeof aiCandidates.$inferSelect;
export type NewAiCandidate = typeof aiCandidates.$inferInsert;
