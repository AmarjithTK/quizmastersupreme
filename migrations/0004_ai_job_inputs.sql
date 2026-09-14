-- M14+: generation job inputs (target, sources) and batch-commit marker.
-- target     — who/what the questions are for (audience or exam), free text.
-- sources    — optional authoritative references the model must stay within.
-- committed_set_id / committed_at — set the whole approved batch was added to.
ALTER TABLE `ai_generation_jobs` ADD COLUMN `target` text;
ALTER TABLE `ai_generation_jobs` ADD COLUMN `sources` text;
ALTER TABLE `ai_generation_jobs` ADD COLUMN `committed_set_id` text;
ALTER TABLE `ai_generation_jobs` ADD COLUMN `committed_at` integer;--> statement-breakpoint