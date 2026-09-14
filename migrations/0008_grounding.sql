-- 0008_grounding.sql
--
-- Grounding cache (PIPELINE-PLAN.md §8).
--
-- OpenRouter bills web search PER REQUEST, and the result text is charged again
-- as input tokens on whatever call carries it. So a job grounds ONCE into a
-- shared source pool that every internal batch reuses as plain text — and the
-- pool is cached here, keyed by the normalised topic + engine, so re-running the
-- same topic costs $0 in search.

CREATE TABLE `grounding_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`engine` text NOT NULL,
	`payload` text NOT NULL,
	`queries` text,
	`cost_usd` real,
	`fetched_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `ix_grounding_expiry` ON `grounding_cache` (`expires_at`);--> statement-breakpoint

-- Per-job override of the global grounding mode ('' = use the setting).
ALTER TABLE `ai_generation_jobs` ADD COLUMN `grounding_mode` text;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `grounding_at` integer;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `grounding_error` text;
