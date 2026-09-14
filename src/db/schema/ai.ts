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

    // ── P0: small-batch generation loop (0007) ────────────────────────────
    /** THE target: how many clean (unflagged) questions the job is driving for. */
    acceptedCount: integer("accepted_count").notNull().default(0),
    /** Questions asked per internal call (default 25, editable 5–50). */
    batchSize: integer("batch_size").notNull().default(25),
    /** Hard cap on provider calls, so refills can never run away. */
    maxCalls: integer("max_calls").notNull().default(20),
    /** JSON: compact concept keys accepted so far, fed to later batches. */
    coveredConcepts: text("covered_concepts"),
    /** JSON (P2): the grounded source pool shared by every batch. */
    sourcePool: text("source_pool"),
    /** Per-job override of the global grounding mode (null = use the setting). */
    groundingMode: text("grounding_mode"),
    groundingCostUsd: real("grounding_cost_usd"),
    groundingCached: integer("grounding_cached").notNull().default(0),
    groundingAt: integer("grounding_at"),
    /** Why grounding produced nothing — reported, never fatal (P2). */
    groundingError: text("grounding_error"),

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

/**
 * One row per INTERNAL generation call (PIPELINE-PLAN.md §4).
 *
 * A job is many of these. Keeping them separate is what makes a weak or failed
 * batch a local problem: it can be regenerated on its own, and its tokens/cost
 * are accounted for on their own.
 */
export const aiGenerationBatches = sqliteTable(
  "ai_generation_batches",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => aiGenerationJobs.id, { onDelete: "cascade" }),
    /** 1-based position in the job's call sequence. */
    batchNo: integer("batch_no").notNull(),
    status: text("status").notNull().default("running"),
    /** How many questions this call asked for. */
    asked: integer("asked").notNull().default(0),
    /** Valid questions stored (includes flagged duplicates). */
    produced: integer("produced").notNull().default(0),
    /** Clean questions that counted toward the target. */
    accepted: integer("accepted").notNull().default(0),
    /** Questions stored but rejected by default (duplicates). */
    flagged: integer("flagged").notNull().default(0),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    costUsd: real("cost_usd"),
    durationMs: integer("duration_ms"),
    rawResponseKey: text("raw_response_key"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("ix_batches_job").on(t.jobId, t.batchNo),
    check(
      "ck_batches_status",
      sql`${t.status} in ('running','succeeded','failed','superseded')`,
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
    /** Which internal call produced it (see ai_generation_batches.batch_no). */
    batchNo: integer("batch_no"),
    /** 1 when a per-batch regenerate replaced it: audited, never committed. */
    superseded: integer("superseded").notNull().default(0),

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

/**
 * Grounding cache (PIPELINE-PLAN.md §8): a normalised topic + engine maps to the
 * source pool that was already paid for, so a repeat topic skips the search.
 */
export const groundingCache = sqliteTable(
  "grounding_cache",
  {
    /** sha256(topic | engine | maxResults | domains). */
    key: text("key").primaryKey(),
    topic: text("topic").notNull(),
    engine: text("engine").notNull(),
    /** JSON SourcePool. */
    payload: text("payload").notNull(),
    /** JSON string[]: the queries the research call actually ran. */
    queries: text("queries"),
    costUsd: real("cost_usd"),
    fetchedAt: integer("fetched_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("ix_grounding_expiry").on(t.expiresAt)],
);

export type GroundingCacheRow = typeof groundingCache.$inferSelect;
export type AiGenerationJob = typeof aiGenerationJobs.$inferSelect;
export type NewAiGenerationJob = typeof aiGenerationJobs.$inferInsert;
export type AiGenerationBatch = typeof aiGenerationBatches.$inferSelect;
export type NewAiGenerationBatch = typeof aiGenerationBatches.$inferInsert;
export type AiCandidate = typeof aiCandidates.$inferSelect;
export type NewAiCandidate = typeof aiCandidates.$inferInsert;
