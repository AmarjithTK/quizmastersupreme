CREATE TABLE `oauth_states` (
	`id` text PRIMARY KEY NOT NULL,
	`code_verifier` text NOT NULL,
	`redirect_to` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_oauth_states_expires` ON `oauth_states` (`expires_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`email_norm` text NOT NULL,
	`google_sub` text,
	`avatar_url` text,
	`email_verified` integer DEFAULT 0 NOT NULL,
	`auth_provider` text DEFAULT 'google' NOT NULL,
	`password_hash` text,
	`display_name` text,
	`role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "ck_users_role" CHECK("__new_users"."role" in ('user','admin')),
	CONSTRAINT "ck_users_status" CHECK("__new_users"."status" in ('active','suspended')),
	CONSTRAINT "ck_users_auth_provider" CHECK("__new_users"."auth_provider" in ('google','password')),
	CONSTRAINT "ck_users_email_verified" CHECK("__new_users"."email_verified" in (0,1))
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "email", "email_norm", "google_sub", "avatar_url", "email_verified", "auth_provider", "password_hash", "display_name", "role", "status", "last_login_at", "created_at", "updated_at") SELECT "id", "email", "email_norm", "google_sub", "avatar_url", "email_verified", "auth_provider", "password_hash", "display_name", "role", "status", "last_login_at", "created_at", "updated_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_norm_unique` ON `users` (`email_norm`);--> statement-breakpoint
CREATE INDEX `ix_users_role` ON `users` (`role`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_users_google_sub` ON `users` (`google_sub`);