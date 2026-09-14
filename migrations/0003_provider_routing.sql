-- M14+: OpenRouter provider routing stored on each job.
-- Both columns hold a JSON array of provider slugs; empty when unset.
-- See docs: provider.only (allow-list) + provider.order (priority).
ALTER TABLE `ai_generation_jobs` ADD COLUMN `provider_only` text;
ALTER TABLE `ai_generation_jobs` ADD COLUMN `provider_order` text;--> statement-breakpoint