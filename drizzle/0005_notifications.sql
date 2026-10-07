CREATE TABLE `notification_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`channel` text NOT NULL,
	`status` text NOT NULL,
	`at` text NOT NULL,
	`error_code` text,
	`retry_after_s` integer,
	FOREIGN KEY (`event_id`) REFERENCES `notification_events`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "notification_deliveries_channel_check" CHECK(channel IN ('telegram', 'fake')),
	CONSTRAINT "notification_deliveries_status_check" CHECK(status IN ('sending', 'sent', 'failed')),
	CONSTRAINT "notification_deliveries_error_check" CHECK(error_code IS NULL OR error_code IN ('timeout', 'network', 'unauthorized', 'forbidden', 'rate_limited', 'bad_request', 'server_error', 'bad_response', 'conflict', 'not_configured', 'unexpected'))
);
--> statement-breakpoint
CREATE INDEX `notification_deliveries_event_idx` ON `notification_deliveries` (event_id,id);--> statement-breakpoint
CREATE TABLE `notification_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`category` text NOT NULL,
	`severity` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`account_id` integer,
	`level` integer,
	`count` integer,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "notification_events_kind_check" CHECK(kind IN ('daily_loss_usage', 'open_risk_usage', 'open_trades_usage', 'drawdown_usage', 'halt_started_daily_loss', 'halt_started_drawdown', 'halt_started_manual', 'halt_cleared', 'drawdown_reset_refused', 'override_logged', 'rule_violation_trade_logged', 'login_failures_burst', 'login_throttled', 'login_success', 'recovery_code_used', 'password_changed', 'security_settings_changed', 'logout_everywhere', 'step_up_failed', 'analyst_daily_calls_usage', 'analyst_monthly_calls_usage', 'analyst_monthly_cost_usage', 'analyst_call_failed', 'notifications_switched_off', 'test_message', 'flood_summary', 'backup_failed', 'market_data_stale')),
	CONSTRAINT "notification_events_category_check" CHECK(category IN ('risk', 'security', 'analyst', 'system')),
	CONSTRAINT "notification_events_severity_check" CHECK(severity IN ('info', 'warning', 'critical')),
	CONSTRAINT "notification_events_level_check" CHECK(level IS NULL OR level IN (50, 80, 100))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_events_dedupe_key_unique` ON `notification_events` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `notification_events_occurred_idx` ON `notification_events` (occurred_at);--> statement-breakpoint
CREATE TABLE `notification_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`master` integer DEFAULT 0 NOT NULL,
	`consent_at` text,
	`categories_json` text NOT NULL,
	`min_severity` text DEFAULT 'info' NOT NULL,
	`pending_json` text DEFAULT '{}' NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "notification_settings_single_row_check" CHECK(id = 1),
	CONSTRAINT "notification_settings_master_check" CHECK(master IN (0, 1)),
	CONSTRAINT "notification_settings_severity_check" CHECK(min_severity IN ('info', 'warning', 'critical'))
);
--> statement-breakpoint
CREATE TABLE `notification_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
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
	CONSTRAINT "auth_events_kind_check" CHECK(kind IN ('owner_created', 'owner_reset', 'login_success', 'login_failure', 'recovery_used', 'step_up_success', 'step_up_failure', 'logout', 'logout_all', 'session_revoked', 'password_changed', 'recovery_regenerated', 'rate_limit_tripped', 'ai_consent_on', 'ai_consent_off', 'ai_caps_changed', 'notifications_on', 'notifications_off', 'notifications_settings_changed'))
);
--> statement-breakpoint
INSERT INTO `__new_auth_events`("id", "kind", "created_at", "session_id", "ip", "user_agent", "detail") SELECT "id", "kind", "created_at", "session_id", "ip", "user_agent", "detail" FROM `auth_events`;--> statement-breakpoint
DROP TABLE `auth_events`;--> statement-breakpoint
ALTER TABLE `__new_auth_events` RENAME TO `auth_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
-- HAND-WRITTEN PART (drizzle-kit generated everything above, including the REBUILD of auth_events
-- that was needed to allow three new event kinds in its CHECK).
-- Dropping the old auth_events dropped its two triggers: they are re-created here, exactly as in
-- 0003 and 0004. Triggers are not tracked by drizzle-kit (a test lists every trigger).
CREATE TRIGGER `auth_events_no_update` BEFORE UPDATE ON `auth_events`
BEGIN
  SELECT RAISE(ABORT, 'auth_events is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `auth_events_no_delete` BEFORE DELETE ON `auth_events`
BEGIN
  SELECT RAISE(ABORT, 'auth_events is append-only');
END;--> statement-breakpoint
-- The notification event log and the delivery attempt log are append-only.
CREATE TRIGGER `notification_events_no_update` BEFORE UPDATE ON `notification_events`
BEGIN
  SELECT RAISE(ABORT, 'notification_events is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `notification_events_no_delete` BEFORE DELETE ON `notification_events`
BEGIN
  SELECT RAISE(ABORT, 'notification_events is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `notification_deliveries_no_update` BEFORE UPDATE ON `notification_deliveries`
BEGIN
  SELECT RAISE(ABORT, 'notification_deliveries is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `notification_deliveries_no_delete` BEFORE DELETE ON `notification_deliveries`
BEGIN
  SELECT RAISE(ABORT, 'notification_deliveries is append-only');
END;--> statement-breakpoint
-- The settings row is never deleted (a missing row would silently mean "defaults").
CREATE TRIGGER `notification_settings_no_delete` BEFORE DELETE ON `notification_settings`
BEGIN
  SELECT RAISE(ABORT, 'the notification settings row cannot be deleted');
END;
