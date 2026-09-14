-- 0007_generation_batches.sql
--
-- Small-batch generation pipeline (PIPELINE-PLAN.md §4).
--
-- One user request is one JOB; internally the job is many small generation
-- CALLS (default 25 questions each) that are filtered and fed forward into the
-- next call's context. This migration adds what that needs:
--
--   1. `ai_generation_batches` — one row per internal call, with its own counts,
--      tokens, cost and status. This is what makes a weak or failed batch
--      recoverable on its own instead of costing the whole job.
--   2. Job counters for the accepted-target loop + the growing concept digest
--      and the (P2) grounding source pool.
--   3. Candidate provenance: which batch produced it, and whether it was
--      superseded by a regenerate (kept for audit, excluded everywhere else).

CREATE TABLE `ai_generation_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`batch_no` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`asked` integer DEFAULT 0 NOT NULL,
	`produced` integer DEFAULT 0 NOT NULL,
	`accepted` integer DEFAULT 0 NOT NULL,
	`flagged` integer DEFAULT 0 NOT NULL,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`cost_usd` real,
	`duration_ms` integer,
	`raw_response_key` text,
	`error_code` text,
	`error_message` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `ai_generation_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_batches_status" CHECK("ai_generation_batches"."status" in ('running','succeeded','failed','superseded'))
);--> statement-breakpoint
CREATE INDEX `ix_batches_job` ON `ai_generation_batches` (`job_id`,`batch_no`);--> statement-breakpoint

ALTER TABLE `ai_generation_jobs` ADD COLUMN `accepted_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `batch_size` integer DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `max_calls` integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `covered_concepts` text;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `source_pool` text;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `grounding_cost_usd` real;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `grounding_cached` integer DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE `ai_candidates` ADD COLUMN `batch_no` integer;--> statement-breakpoint
ALTER TABLE `ai_candidates` ADD COLUMN `superseded` integer DEFAULT 0 NOT NULL;
