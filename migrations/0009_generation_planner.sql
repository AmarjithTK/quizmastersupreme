-- 0009_generation_planner.sql
--
-- Plan-first generation, full-funnel accounting, and recoverable execution.
-- Additive on purpose: existing jobs/candidates remain readable and the legacy
-- job-status CHECK does not need a risky table rebuild.

ALTER TABLE `ai_generation_jobs` ADD COLUMN `phase` text;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `planner_version` text;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `plan_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `blueprint_json` text;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `blueprint_hash` text;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `plan_approved_by` text;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `plan_approved_at` integer;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `planner_prompt_tokens` integer;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `planner_completion_tokens` integer;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `planner_cost_usd` real;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `planner_raw_response_key` text;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `raw_item_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `model_shortfall_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `schema_invalid_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `content_invalid_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `policy_rejected_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `lease_token` text;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `lease_expires_at` integer;--> statement-breakpoint

ALTER TABLE `ai_generation_batches` ADD COLUMN `directive_json` text;--> statement-breakpoint
ALTER TABLE `ai_generation_batches` ADD COLUMN `directive_hash` text;--> statement-breakpoint
ALTER TABLE `ai_generation_batches` ADD COLUMN `plan_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_batches` ADD COLUMN `raw_item_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_batches` ADD COLUMN `model_shortfall_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_batches` ADD COLUMN `schema_valid_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_batches` ADD COLUMN `schema_invalid_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_batches` ADD COLUMN `content_valid_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_batches` ADD COLUMN `content_invalid_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_batches` ADD COLUMN `policy_valid_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_batches` ADD COLUMN `policy_rejected_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_batches` ADD COLUMN `duplicate_flagged_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_batches` ADD COLUMN `response_format_mode` text;--> statement-breakpoint
ALTER TABLE `ai_generation_batches` ADD COLUMN `finish_reason` text;--> statement-breakpoint
ALTER TABLE `ai_generation_batches` ADD COLUMN `parse_repair` text;--> statement-breakpoint
ALTER TABLE `ai_generation_batches` ADD COLUMN `attempt_no` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_batches` ADD COLUMN `lease_token` text;--> statement-breakpoint
ALTER TABLE `ai_generation_batches` ADD COLUMN `request_manifest_key` text;--> statement-breakpoint
ALTER TABLE `ai_generation_batches` ADD COLUMN `raw_provider_response_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `ux_generation_batches_job_no` ON `ai_generation_batches` (`job_id`,`batch_no`);--> statement-breakpoint

ALTER TABLE `ai_candidates` ADD COLUMN `segment_id` text;--> statement-breakpoint
ALTER TABLE `ai_candidates` ADD COLUMN `entity_key` text;--> statement-breakpoint
ALTER TABLE `ai_candidates` ADD COLUMN `fact_key` text;--> statement-breakpoint
ALTER TABLE `ai_candidates` ADD COLUMN `question_type` text;--> statement-breakpoint
ALTER TABLE `ai_candidates` ADD COLUMN `source_ids_json` text;--> statement-breakpoint
ALTER TABLE `ai_candidates` ADD COLUMN `rejection_kind` text;--> statement-breakpoint
ALTER TABLE `ai_candidates` ADD COLUMN `rejection_reason` text;--> statement-breakpoint
ALTER TABLE `ai_candidates` ADD COLUMN `plan_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint

CREATE TABLE `ai_generation_segments` (
  `id` text PRIMARY KEY NOT NULL,
  `job_id` text NOT NULL,
  `plan_revision` integer NOT NULL,
  `key` text NOT NULL,
  `label` text NOT NULL,
  `intent` text NOT NULL,
  `target_count` integer NOT NULL,
  `priority` integer DEFAULT 1 NOT NULL,
  `accepted_count` integer DEFAULT 0 NOT NULL,
  `rejected_count` integer DEFAULT 0 NOT NULL,
  `invalid_count` integer DEFAULT 0 NOT NULL,
  `source_fact_count` integer DEFAULT 0 NOT NULL,
  `policy_json` text NOT NULL,
  `source_queries_json` text NOT NULL,
  `source_requirements_json` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`job_id`) REFERENCES `ai_generation_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `ck_generation_segments_status` CHECK(`status` in ('pending','active','complete','source_limited'))
);--> statement-breakpoint
CREATE INDEX `ix_generation_segments_job` ON `ai_generation_segments` (`job_id`,`plan_revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_generation_segments_key` ON `ai_generation_segments` (`job_id`,`plan_revision`,`key`);--> statement-breakpoint

CREATE TABLE `ai_source_facts` (
  `id` text PRIMARY KEY NOT NULL,
  `job_id` text NOT NULL,
  `segment_id` text,
  `entity_key` text,
  `claim` text NOT NULL,
  `source_url` text NOT NULL,
  `source_title` text NOT NULL,
  `published_at` text,
  `freshness` text DEFAULT 'stable' NOT NULL,
  `retrieved_at` integer NOT NULL,
  FOREIGN KEY (`job_id`) REFERENCES `ai_generation_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`segment_id`) REFERENCES `ai_generation_segments`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `ix_source_facts_job_segment` ON `ai_source_facts` (`job_id`,`segment_id`);--> statement-breakpoint

CREATE TABLE `ai_generation_rejections` (
  `id` text PRIMARY KEY NOT NULL,
  `job_id` text NOT NULL,
  `batch_id` text NOT NULL,
  `batch_no` integer NOT NULL,
  `model_index` integer NOT NULL,
  `stage` text NOT NULL,
  `code` text NOT NULL,
  `reasons_json` text NOT NULL,
  `raw_json` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`job_id`) REFERENCES `ai_generation_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`batch_id`) REFERENCES `ai_generation_batches`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `ck_generation_rejections_stage` CHECK(`stage` in ('schema','content','policy'))
);--> statement-breakpoint
CREATE INDEX `ix_generation_rejections_job_batch` ON `ai_generation_rejections` (`job_id`,`batch_no`,`stage`);
