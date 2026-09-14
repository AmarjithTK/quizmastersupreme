CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`user_agent` text,
	`ip_hash` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_auth_sessions_user` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `ix_auth_sessions_expires` ON `auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`email_norm` text NOT NULL,
	`password_hash` text NOT NULL,
	`display_name` text,
	`role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "ck_users_role" CHECK("users"."role" in ('user','admin')),
	CONSTRAINT "ck_users_status" CHECK("users"."status" in ('active','suspended'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_norm_unique` ON `users` (`email_norm`);--> statement-breakpoint
CREATE INDEX `ix_users_role` ON `users` (`role`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text,
	`description` text,
	`icon` text,
	`accent_color` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "ck_categories_status" CHECK("categories"."status" in ('draft','published','archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_unique` ON `categories` (`slug`);--> statement-breakpoint
CREATE INDEX `ix_categories_status_sort` ON `categories` (`status`,`sort_order`);--> statement-breakpoint
CREATE TABLE `quiz_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`group_label` text,
	`mode` text DEFAULT 'practice' NOT NULL,
	`difficulty` text DEFAULT 'medium' NOT NULL,
	`time_limit_seconds` integer,
	`question_limit` integer,
	`shuffle_questions` integer DEFAULT 1 NOT NULL,
	`shuffle_options` integer DEFAULT 0 NOT NULL,
	`passing_percent` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`published_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_quiz_sets_status" CHECK("quiz_sets"."status" in ('draft','published','archived')),
	CONSTRAINT "ck_quiz_sets_mode" CHECK("quiz_sets"."mode" in ('practice','mock')),
	CONSTRAINT "ck_quiz_sets_difficulty" CHECK("quiz_sets"."difficulty" in ('easy','medium','hard','expert','mixed')),
	CONSTRAINT "ck_quiz_sets_shuffle_q" CHECK("quiz_sets"."shuffle_questions" in (0,1)),
	CONSTRAINT "ck_quiz_sets_shuffle_o" CHECK("quiz_sets"."shuffle_options" in (0,1)),
	CONSTRAINT "ck_quiz_sets_passing" CHECK("quiz_sets"."passing_percent" is null or ("quiz_sets"."passing_percent" between 0 and 100))
);
--> statement-breakpoint
CREATE INDEX `ix_quiz_sets_category` ON `quiz_sets` (`category_id`,`status`,`sort_order`);--> statement-breakpoint
CREATE INDEX `ix_quiz_sets_status` ON `quiz_sets` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_quiz_sets_category_slug` ON `quiz_sets` (`category_id`,`slug`);--> statement-breakpoint
CREATE TABLE `question_options` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`option_key` text NOT NULL,
	`body` text NOT NULL,
	`is_correct` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_question_options_key" CHECK("question_options"."option_key" in ('A','B','C','D','E')),
	CONSTRAINT "ck_question_options_correct" CHECK("question_options"."is_correct" in (0,1))
);
--> statement-breakpoint
CREATE INDEX `ix_question_options_question` ON `question_options` (`question_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_question_options_single_correct` ON `question_options` (`question_id`) WHERE "question_options"."is_correct" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_question_options_key` ON `question_options` (`question_id`,`option_key`);--> statement-breakpoint
CREATE TABLE `question_set_questions` (
	`set_id` text NOT NULL,
	`question_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`set_id`, `question_id`),
	FOREIGN KEY (`set_id`) REFERENCES `quiz_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_qsq_set_order` ON `question_set_questions` (`set_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `ix_qsq_question` ON `question_set_questions` (`question_id`);--> statement-breakpoint
CREATE TABLE `questions` (
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
	`status` text DEFAULT 'draft' NOT NULL,
	`normalized_hash` text NOT NULL,
	`simhash` text,
	`content_hash` text NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`created_by` text,
	`generation_job_id` text,
	`approved_by` text,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "ck_questions_status" CHECK("questions"."status" in ('ai_draft','draft','review','approved','published','rejected','duplicate','archived')),
	CONSTRAINT "ck_questions_difficulty" CHECK("questions"."difficulty" in ('easy','medium','hard','expert')),
	CONSTRAINT "ck_questions_origin" CHECK("questions"."origin" in ('manual','ai','import','seed')),
	CONSTRAINT "ck_questions_stem_format" CHECK("questions"."stem_format" in ('plain','markdown')),
	CONSTRAINT "ck_questions_backstory_format" CHECK("questions"."backstory_format" in ('plain','markdown'))
);
--> statement-breakpoint
CREATE INDEX `ix_questions_status` ON `questions` (`status`);--> statement-breakpoint
CREATE INDEX `ix_questions_topic` ON `questions` (`topic`,`difficulty`);--> statement-breakpoint
CREATE INDEX `ix_questions_normalized_hash` ON `questions` (`normalized_hash`);--> statement-breakpoint
CREATE INDEX `ix_questions_content_hash` ON `questions` (`content_hash`);--> statement-breakpoint
CREATE INDEX `ix_questions_generation_job` ON `questions` (`generation_job_id`);--> statement-breakpoint
CREATE TABLE `quiz_attempt_answers` (
	`attempt_id` text NOT NULL,
	`question_id` text NOT NULL,
	`question_index` integer NOT NULL,
	`selected_option_key` text,
	`is_correct` integer,
	`time_taken_ms` integer DEFAULT 0 NOT NULL,
	`answered_at` integer NOT NULL,
	`client_seq` integer,
	PRIMARY KEY(`attempt_id`, `question_id`),
	FOREIGN KEY (`attempt_id`) REFERENCES `quiz_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_answers_attempt` ON `quiz_attempt_answers` (`attempt_id`,`question_index`);--> statement-breakpoint
CREATE TABLE `quiz_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`set_id` text NOT NULL,
	`status` text DEFAULT 'in_progress' NOT NULL,
	`question_order` text NOT NULL,
	`option_order` text,
	`total_questions` integer NOT NULL,
	`current_index` integer DEFAULT 0 NOT NULL,
	`answered_count` integer DEFAULT 0 NOT NULL,
	`correct_count` integer DEFAULT 0 NOT NULL,
	`wrong_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`time_limit_seconds` integer,
	`server_deadline_at` integer,
	`time_spent_ms` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`set_id`) REFERENCES `quiz_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_attempts_status" CHECK("quiz_attempts"."status" in ('in_progress','completed','abandoned','expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_attempt_active` ON `quiz_attempts` (`user_id`,`set_id`) WHERE "quiz_attempts"."status" = 'in_progress';--> statement-breakpoint
CREATE INDEX `ix_attempts_user` ON `quiz_attempts` (`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `ix_attempts_set` ON `quiz_attempts` (`set_id`);--> statement-breakpoint
CREATE TABLE `user_question_seen` (
	`user_id` text NOT NULL,
	`question_id` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`times_seen` integer DEFAULT 1 NOT NULL,
	`times_correct` integer DEFAULT 0 NOT NULL,
	`last_is_correct` integer,
	PRIMARY KEY(`user_id`, `question_id`),
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_uqs_user_recent` ON `user_question_seen` (`user_id`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `user_set_stats` (
	`user_id` text NOT NULL,
	`set_id` text NOT NULL,
	`attempts_count` integer DEFAULT 0 NOT NULL,
	`completed_count` integer DEFAULT 0 NOT NULL,
	`best_correct` integer DEFAULT 0 NOT NULL,
	`best_total` integer DEFAULT 0 NOT NULL,
	`best_percent` integer,
	`questions_seen` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	`first_completed_at` integer,
	PRIMARY KEY(`user_id`, `set_id`),
	FOREIGN KEY (`set_id`) REFERENCES `quiz_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ai_candidates` (
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
	`validation_status` text DEFAULT 'pending' NOT NULL,
	`validation_errors` text,
	`dedupe_status` text DEFAULT 'pending' NOT NULL,
	`dedupe_layer` text,
	`dedupe_best_match_id` text,
	`dedupe_similarity` real,
	`dedupe_detail` text,
	`normalized_hash` text,
	`simhash` text,
	`review_status` text DEFAULT 'pending' NOT NULL,
	`reviewed_by` text,
	`reviewed_at` integer,
	`review_note` text,
	`promoted_question_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `ai_generation_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dedupe_best_match_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`promoted_question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_candidates_validation" CHECK("ai_candidates"."validation_status" in ('pending','valid','invalid')),
	CONSTRAINT "ck_candidates_dedupe" CHECK("ai_candidates"."dedupe_status" in ('pending','clean','exact_dup','near_dup','semantic_dup','error')),
	CONSTRAINT "ck_candidates_review" CHECK("ai_candidates"."review_status" in ('pending','approved','rejected','merged','deferred'))
);
--> statement-breakpoint
CREATE INDEX `ix_candidates_job` ON `ai_candidates` (`job_id`,`review_status`);--> statement-breakpoint
CREATE INDEX `ix_candidates_review` ON `ai_candidates` (`review_status`,`created_at`);--> statement-breakpoint
CREATE TABLE `ai_generation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_by` text NOT NULL,
	`target_category_id` text,
	`target_set_id` text,
	`brief` text NOT NULL,
	`topic` text NOT NULL,
	`subtopics` text,
	`difficulty` text,
	`requested_count` integer NOT NULL,
	`avoid_topics` text,
	`provider` text DEFAULT 'openrouter' NOT NULL,
	`model` text NOT NULL,
	`temperature` real,
	`prompt_version` text NOT NULL,
	`coverage_digest` text,
	`coverage_tokens` integer,
	`include_examples` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`produced_count` integer DEFAULT 0 NOT NULL,
	`valid_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`cost_usd` real,
	`duration_ms` integer,
	`raw_response_key` text,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`target_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_set_id`) REFERENCES `quiz_sets`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_jobs_status" CHECK("ai_generation_jobs"."status" in ('queued','running','succeeded','partial','failed','cancelled'))
);
--> statement-breakpoint
CREATE INDEX `ix_jobs_status` ON `ai_generation_jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_jobs_creator` ON `ai_generation_jobs` (`created_by`,`created_at`);--> statement-breakpoint
CREATE TABLE `duplicate_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`matched_question_id` text NOT NULL,
	`layer` text NOT NULL,
	`similarity` real NOT NULL,
	`detail` text,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`matched_question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_dupflags_layer" CHECK("duplicate_flags"."layer" in ('exact','text','semantic')),
	CONSTRAINT "ck_dupflags_status" CHECK("duplicate_flags"."status" in ('open','confirmed','dismissed','merged')),
	CONSTRAINT "ck_dupflags_not_self" CHECK("duplicate_flags"."question_id" <> "duplicate_flags"."matched_question_id")
);
--> statement-breakpoint
CREATE INDEX `ix_dupflags_status` ON `duplicate_flags` (`status`,`similarity`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dupflags_pair` ON `duplicate_flags` (`question_id`,`matched_question_id`,`layer`);--> statement-breakpoint
CREATE TABLE `question_embeddings` (
	`question_id` text NOT NULL,
	`model` text NOT NULL,
	`dimensions` integer NOT NULL,
	`content_hash` text NOT NULL,
	`vectorize_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`question_id`, `model`),
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`before_json` text,
	`after_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_audit_entity` ON `audit_log` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_actor` ON `audit_log` (`actor_id`,`created_at`);