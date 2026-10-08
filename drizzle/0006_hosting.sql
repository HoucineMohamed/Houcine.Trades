CREATE TABLE `backup_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`outcome` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text NOT NULL,
	`object_key` text,
	`size_bytes` integer,
	`sha256` text,
	`error_code` text,
	CONSTRAINT "backup_runs_kind_check" CHECK(kind IN ('daily', 'pre-migration', 'manual')),
	CONSTRAINT "backup_runs_outcome_check" CHECK(outcome IN ('ok', 'failed')),
	CONSTRAINT "backup_runs_error_check" CHECK(error_code IS NULL OR error_code IN ('snapshot_failed', 'snapshot_corrupt', 'encrypt_failed', 'upload_failed', 'verify_failed', 'store_unreachable', 'store_denied', 'not_configured', 'unexpected')),
	CONSTRAINT "backup_runs_outcome_fields_check" CHECK((outcome = 'ok' AND object_key IS NOT NULL AND sha256 IS NOT NULL AND error_code IS NULL) OR (outcome = 'failed' AND error_code IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `backup_runs_finished_idx` ON `backup_runs` (finished_at);--> statement-breakpoint
-- Backup runs are append-only: a failed or missing backup can never be edited away.
CREATE TRIGGER `backup_runs_no_update` BEFORE UPDATE ON `backup_runs`
BEGIN
  SELECT RAISE(ABORT, 'backup_runs is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `backup_runs_no_delete` BEFORE DELETE ON `backup_runs`
BEGIN
  SELECT RAISE(ABORT, 'backup_runs is append-only');
END;--> statement-breakpoint
-- notification_events must accept the new system kinds. A CHECK cannot be changed, so the table is
-- rebuilt. It is referenced by notification_deliveries (ON DELETE RESTRICT) and the migrator runs
-- inside one transaction (PRAGMA foreign_keys has no effect there), so the CHILD is copied out and
-- dropped first, then the parent is rebuilt, then both are filled again with their ids unchanged.
-- Dropping a table does not fire the append-only triggers; they are re-created below.
CREATE TABLE `__keep_events` AS SELECT * FROM `notification_events`;--> statement-breakpoint
CREATE TABLE `__keep_deliveries` AS SELECT * FROM `notification_deliveries`;--> statement-breakpoint
DROP TABLE `notification_deliveries`;--> statement-breakpoint
DROP TABLE `notification_events`;--> statement-breakpoint
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
	CONSTRAINT "notification_events_kind_check" CHECK(kind IN ('daily_loss_usage', 'open_risk_usage', 'open_trades_usage', 'drawdown_usage', 'halt_started_daily_loss', 'halt_started_drawdown', 'halt_started_manual', 'halt_cleared', 'drawdown_reset_refused', 'override_logged', 'rule_violation_trade_logged', 'login_failures_burst', 'login_throttled', 'login_success', 'recovery_code_used', 'password_changed', 'security_settings_changed', 'logout_everywhere', 'step_up_failed', 'analyst_daily_calls_usage', 'analyst_monthly_calls_usage', 'analyst_monthly_cost_usage', 'analyst_call_failed', 'notifications_switched_off', 'test_message', 'flood_summary', 'backup_failed', 'backup_succeeded', 'backup_stale', 'migration_applied', 'migration_failed', 'restore_applied', 'market_data_stale')),
	CONSTRAINT "notification_events_category_check" CHECK(category IN ('risk', 'security', 'analyst', 'system')),
	CONSTRAINT "notification_events_severity_check" CHECK(severity IN ('info', 'warning', 'critical')),
	CONSTRAINT "notification_events_level_check" CHECK(level IS NULL OR level IN (50, 80, 100))
);
--> statement-breakpoint
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
INSERT INTO `notification_events` (`id`, `kind`, `category`, `severity`, `dedupe_key`, `account_id`, `level`, `count`, `occurred_at`, `created_at`) SELECT `id`, `kind`, `category`, `severity`, `dedupe_key`, `account_id`, `level`, `count`, `occurred_at`, `created_at` FROM `__keep_events` ORDER BY `id`;--> statement-breakpoint
INSERT INTO `notification_deliveries` (`id`, `event_id`, `channel`, `status`, `at`, `error_code`, `retry_after_s`) SELECT `id`, `event_id`, `channel`, `status`, `at`, `error_code`, `retry_after_s` FROM `__keep_deliveries` ORDER BY `id`;--> statement-breakpoint
DROP TABLE `__keep_deliveries`;--> statement-breakpoint
DROP TABLE `__keep_events`;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_events_dedupe_key_unique` ON `notification_events` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `notification_events_occurred_idx` ON `notification_events` (occurred_at);--> statement-breakpoint
CREATE INDEX `notification_deliveries_event_idx` ON `notification_deliveries` (event_id,id);--> statement-breakpoint
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
END;
