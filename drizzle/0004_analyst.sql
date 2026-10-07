CREATE TABLE `ai_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`account_id` integer,
	`range_from` text,
	`range_to` text,
	`currency` text,
	`subject` text DEFAULT '' NOT NULL,
	`input_hash` text NOT NULL,
	`output_json` text NOT NULL,
	`checks_json` text NOT NULL,
	`usage_id` integer NOT NULL,
	`model` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`usage_id`) REFERENCES `ai_usage`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ai_reviews_kind_check" CHECK(kind IN ('plan_review', 'weekly_review', 'tutor'))
);
--> statement-breakpoint
CREATE INDEX `ai_reviews_kind_idx` ON `ai_reviews` (kind,id);--> statement-breakpoint
CREATE TABLE `ai_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`consent` integer DEFAULT 0 NOT NULL,
	`caps_json` text NOT NULL,
	`pending_caps_json` text DEFAULT '{}' NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "ai_settings_single_row_check" CHECK(id = 1),
	CONSTRAINT "ai_settings_consent_check" CHECK(consent IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `ai_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text NOT NULL,
	`feature` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`estimated_cost_usd` text NOT NULL,
	`status` text NOT NULL,
	CONSTRAINT "ai_usage_feature_check" CHECK(feature IN ('plan_review', 'weekly_review', 'tutor')),
	CONSTRAINT "ai_usage_status_check" CHECK(status IN ('ok', 'api_error', 'timeout', 'refused', 'truncated', 'invalid_output')),
	CONSTRAINT "ai_usage_tokens_check" CHECK(input_tokens >= 0 AND output_tokens >= 0)
);
--> statement-breakpoint
CREATE INDEX `ai_usage_created_at_idx` ON `ai_usage` (created_at);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_auth_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL,
	`session_id` integer,
	`ip` text DEFAULT '' NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "auth_events_kind_check" CHECK(kind IN ('owner_created', 'owner_reset', 'login_success', 'login_failure', 'recovery_used', 'step_up_success', 'step_up_failure', 'logout', 'logout_all', 'session_revoked', 'password_changed', 'recovery_regenerated', 'rate_limit_tripped', 'ai_consent_on', 'ai_consent_off', 'ai_caps_changed'))
);
--> statement-breakpoint
INSERT INTO `__new_auth_events`("id", "kind", "created_at", "session_id", "ip", "user_agent", "detail") SELECT "id", "kind", "created_at", "session_id", "ip", "user_agent", "detail" FROM `auth_events`;--> statement-breakpoint
DROP TABLE `auth_events`;--> statement-breakpoint
ALTER TABLE `__new_auth_events` RENAME TO `auth_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
-- HAND-WRITTEN PART (drizzle-kit generated everything above, including the REBUILD of auth_events
-- that was needed to allow three new event kinds in its CHECK).
-- Dropping the old auth_events dropped its two triggers: they are re-created here, exactly as in
-- 0003. Triggers are not tracked by drizzle-kit (a test lists every trigger and fails if one is missing).
CREATE TRIGGER `auth_events_no_update` BEFORE UPDATE ON `auth_events`
BEGIN
  SELECT RAISE(ABORT, 'auth_events is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `auth_events_no_delete` BEFORE DELETE ON `auth_events`
BEGIN
  SELECT RAISE(ABORT, 'auth_events is append-only');
END;--> statement-breakpoint
-- The analyst usage log and the stored reviews are append-only.
CREATE TRIGGER `ai_usage_no_update` BEFORE UPDATE ON `ai_usage`
BEGIN
  SELECT RAISE(ABORT, 'ai_usage is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `ai_usage_no_delete` BEFORE DELETE ON `ai_usage`
BEGIN
  SELECT RAISE(ABORT, 'ai_usage is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `ai_reviews_no_update` BEFORE UPDATE ON `ai_reviews`
BEGIN
  SELECT RAISE(ABORT, 'ai_reviews is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `ai_reviews_no_delete` BEFORE DELETE ON `ai_reviews`
BEGIN
  SELECT RAISE(ABORT, 'ai_reviews is append-only');
END;--> statement-breakpoint
-- The settings row is never deleted (a missing row would silently mean "defaults").
CREATE TRIGGER `ai_settings_no_delete` BEFORE DELETE ON `ai_settings`
BEGIN
  SELECT RAISE(ABORT, 'the analyst settings row cannot be deleted');
END;
