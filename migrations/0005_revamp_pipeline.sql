-- 0005_revamp_pipeline.sql
--
-- Hand-written (see MIGRATIONS.md). The simplification revamp — REVAMP-PLAN.md.
--
--   1. `questions.status` collapses 8 values -> 3:
--        ai_draft|draft|review|approved|published -> 'active'
--        duplicate|rejected                        -> 'rejected'
--        archived                                  -> 'archived'
--      and the unused `simhash` column is dropped. SQLite cannot alter a CHECK,
--      so the table is rebuilt with the proven 0002 pattern.
--
--   2. `ai_candidates` becomes a plain WORKING SET for one generation batch:
--      no validation/dedupe/review state machines, no promote pointer. Rows are
--      the fresh, valid questions a job produced; commit inserts them directly.
--
--   3. Drops `duplicate_flags` and `question_embeddings` — the retroactive
--      duplicate sweep and the (never-wired) vector index are retired. Dedupe
--      is layers 1-2 at write time.
--
--   4. `ai_generation_jobs` gains the generate-to-N counters.
--
-- Apply BEFORE deploying code that reads the new shape.

PRAGMA foreign_keys=OFF;--> statement-breakpoint

-- ── 1. questions: rebuild with 3 statuses, no simhash ────────────────────────
CREATE TABLE `__new_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`stem` text NOT NULL,
	`stem_format` text DEFAULT 'markdown' NOT NULL,
	`explanation` text,
	`backstory` text,
	`backstory_format` text DEFAULT 'markdown' NOT NULL,
	`difficulty` text DEFAULT 'medium' NOT NULL,
	`topic` text,
	`tags` text,
	`year` integer,
	`source` text,
	`source_url` text,
	`exam_body` text,
	`language` text DEFAULT 'en' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`normalized_hash` text NOT NULL,
	`content_hash` text NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`created_by` text,
	`generation_job_id` text,
	`approved_by` text,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "ck_questions_status" CHECK("__new_questions"."status" in ('active','rejected','archived')),
	CONSTRAINT "ck_questions_difficulty" CHECK("__new_questions"."difficulty" in ('easy','medium','hard','expert')),
	CONSTRAINT "ck_questions_origin" CHECK("__new_questions"."origin" in ('manual','ai','import','seed')),
	CONSTRAINT "ck_questions_stem_format" CHECK("__new_questions"."stem_format" in ('plain','markdown')),
	CONSTRAINT "ck_questions_backstory_format" CHECK("__new_questions"."backstory_format" in ('plain','markdown'))
);--> statement-breakpoint
INSERT INTO `__new_questions`("id","stem","stem_format","explanation","backstory","backstory_format","difficulty","topic","tags","year","source","source_url","exam_body","language","status","normalized_hash","content_hash","origin","created_by","generation_job_id","approved_by","approved_at","created_at","updated_at")
SELECT "id","stem","stem_format","explanation","backstory","backstory_format","difficulty","topic","tags","year","source","source_url","exam_body","language",
	CASE "status"
		WHEN 'archived' THEN 'archived'
		WHEN 'rejected' THEN 'rejected'
		WHEN 'duplicate' THEN 'rejected'
		ELSE 'active'
	END,
	"normalized_hash","content_hash","origin","created_by","generation_job_id","approved_by","approved_at","created_at","updated_at"
FROM `questions`;--> statement-breakpoint
DROP TABLE `questions`;--> statement-breakpoint
ALTER TABLE `__new_questions` RENAME TO `questions`;--> statement-breakpoint
CREATE INDEX `ix_questions_status` ON `questions` (`status`);--> statement-breakpoint
CREATE INDEX `ix_questions_topic` ON `questions` (`topic`,`difficulty`);--> statement-breakpoint
CREATE INDEX `ix_questions_normalized_hash` ON `questions` (`normalized_hash`);--> statement-breakpoint
CREATE INDEX `ix_questions_content_hash` ON `questions` (`content_hash`);--> statement-breakpoint
CREATE INDEX `ix_questions_generation_job` ON `questions` (`generation_job_id`);--> statement-breakpoint

-- FTS content is rebuilt (the virtual table outlives the drop, row triggers
-- did not fire) and the triggers are recreated below.
DELETE FROM `questions_fts`;--> statement-breakpoint
INSERT INTO `questions_fts`(question_id, stem, explanation, topic, tags)
	SELECT "id", "stem", COALESCE("explanation", ''), COALESCE("topic", ''), COALESCE("tags", '') FROM `questions`;--> statement-breakpoint
CREATE TRIGGER `questions_fts_ai` AFTER INSERT ON `questions` BEGIN
  INSERT INTO `questions_fts`(question_id, stem, explanation, topic, tags)
  VALUES (new.id, new.stem, COALESCE(new.explanation, ''), COALESCE(new.topic, ''), COALESCE(new.tags, ''));
END;--> statement-breakpoint
CREATE TRIGGER `questions_fts_ad` AFTER DELETE ON `questions` BEGIN
  DELETE FROM `questions_fts` WHERE question_id = old.id;
END;--> statement-breakpoint
CREATE TRIGGER `questions_fts_au` AFTER UPDATE ON `questions` BEGIN
  DELETE FROM `questions_fts` WHERE question_id = old.id;
  INSERT INTO `questions_fts`(question_id, stem, explanation, topic, tags)
  VALUES (new.id, new.stem, COALESCE(new.explanation, ''), COALESCE(new.topic, ''), COALESCE(new.tags, ''));
END;--> statement-breakpoint

-- ── 2. ai_candidates: the job's working set ──────────────────────────────────
CREATE TABLE `__new_ai_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`batch_index` integer,
	`stem` text NOT NULL,
	`options_json` text NOT NULL,
	`correct_option_key` text NOT NULL,
	`explanation` text,
	`backstory` text,
	`difficulty` text,
	`topic` text,
	`tags` text,
	`rejected` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `ai_generation_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_candidates_correct_key" CHECK("__new_ai_candidates"."correct_option_key" in ('A','B','C','D','E')),
	CONSTRAINT "ck_candidates_rejected" CHECK("__new_ai_candidates"."rejected" in (0,1))
);--> statement-breakpoint
INSERT INTO `__new_ai_candidates`("id","job_id","batch_index","stem","options_json","correct_option_key","explanation","backstory","difficulty","topic","tags","rejected","created_at")
SELECT "id","job_id","batch_index","stem","options_json","correct_option_key","explanation","backstory","difficulty","topic","tags",
	CASE WHEN "review_status" = 'rejected' THEN 1 ELSE 0 END,
	"created_at"
FROM `ai_candidates`
WHERE "validation_status" = 'valid';--> statement-breakpoint
DROP TABLE `ai_candidates`;--> statement-breakpoint
ALTER TABLE `__new_ai_candidates` RENAME TO `ai_candidates`;--> statement-breakpoint
CREATE INDEX `ix_candidates_job` ON `ai_candidates` (`job_id`,`rejected`);--> statement-breakpoint
CREATE INDEX `ix_candidates_created` ON `ai_candidates` (`created_at`);--> statement-breakpoint

-- ── 3. retire the sweep + vector index ───────────────────────────────────────
DROP TABLE IF EXISTS `duplicate_flags`;--> statement-breakpoint
DROP TABLE IF EXISTS `question_embeddings`;--> statement-breakpoint

-- ── 4. generate-to-N counters ────────────────────────────────────────────────
ALTER TABLE `ai_generation_jobs` ADD COLUMN `backfill_round` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_generation_jobs` ADD COLUMN `duplicate_skipped` integer DEFAULT 0 NOT NULL;--> statement-breakpoint

PRAGMA foreign_keys=ON;
