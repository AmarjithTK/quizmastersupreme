-- 0006_candidate_dedupe.sql
--
-- Duplicate POLICY change for generated questions (hand-written; see MIGRATIONS.md).
--
-- Previously the pipeline DROPPED duplicates silently (they were counted and
-- discarded). The product now wants them VISIBLE and REJECTED BY DEFAULT, with
-- the matching existing question shown, so a human can override.
--
-- These columns record WHY a generated question was flagged. `rejected` (added in
-- 0005) carries the default decision: 1 when dedupe_status <> 'clean'. Accepting a
-- flagged candidate is just `rejected = 0`.
--
-- Values are validated in the app layer (modules/ai) rather than with a CHECK:
-- SQLite cannot add a CHECK to an existing table without a full rebuild, and the
-- write path is a single funnel.

ALTER TABLE `ai_candidates` ADD COLUMN `dedupe_status` text DEFAULT 'clean' NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_candidates` ADD COLUMN `dedupe_matched_question_id` text;--> statement-breakpoint
ALTER TABLE `ai_candidates` ADD COLUMN `dedupe_matched_stem` text;--> statement-breakpoint
ALTER TABLE `ai_candidates` ADD COLUMN `dedupe_similarity` real;--> statement-breakpoint
ALTER TABLE `ai_candidates` ADD COLUMN `dedupe_reason` text;
