CREATE TABLE `risk_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`kind` text NOT NULL,
	`halt_kind` text,
	`trade_id` integer,
	`reason` text DEFAULT '' NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`trade_id`) REFERENCES `trades`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "risk_events_kind_check" CHECK(kind IN ('halt', 'reset', 'reset_refused', 'plan_refused', 'override', 'settings_change', 'settings_applied')),
	CONSTRAINT "risk_events_halt_kind_check" CHECK(halt_kind IS NULL OR halt_kind IN ('daily_loss', 'drawdown', 'manual'))
);
--> statement-breakpoint
CREATE INDEX `risk_events_account_id_idx` ON `risk_events` (account_id,id);--> statement-breakpoint
CREATE TABLE `risk_settings` (
	`account_id` integer PRIMARY KEY NOT NULL,
	`settings_json` text NOT NULL,
	`pending_json` text DEFAULT '{}' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `risk_verdicts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trade_id` integer NOT NULL,
	`stage` text NOT NULL,
	`approved` integer NOT NULL,
	`violation_codes` text NOT NULL,
	`warning_codes` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`override_reason` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`trade_id`) REFERENCES `trades`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "risk_verdicts_stage_check" CHECK(stage IN ('created', 'opened')),
	CONSTRAINT "risk_verdicts_approved_check" CHECK(approved IN (0, 1)),
	CONSTRAINT "risk_verdicts_override_check" CHECK(approved = 1 OR (override_reason IS NOT NULL AND length(override_reason) > 0))
);
--> statement-breakpoint
CREATE INDEX `risk_verdicts_trade_id_idx` ON `risk_verdicts` (trade_id);--> statement-breakpoint
ALTER TABLE `trades` ADD `closed_recorded_at` text;
--> statement-breakpoint
-- HAND-WRITTEN PART (drizzle-kit generated the tables, indexes and ADD COLUMN above).
-- Backfill: trades that were already closed get the best available "recorded as closed" time,
-- their last update time. (Editing a closed trade's notes later may have moved it, so for OLD
-- trades this is only approximate; every trade closed from now on gets the exact time.)
UPDATE `trades` SET `closed_recorded_at` = `updated_at` WHERE `status` = 'closed';--> statement-breakpoint
-- Accounts that already exist get the default risk settings (new accounts get them when created).
INSERT INTO `risk_settings` (`account_id`, `settings_json`, `pending_json`, `updated_at`)
SELECT `id`,
  '{"maxRiskPerTradePercent":"1","maxDailyLossPercent":"3","maxOpenRiskPercent":"3","maxOpenTrades":3,"maxDrawdownPercent":"10","minRewardToRisk":"1.5"}',
  '{}',
  `created_at`
FROM `accounts`;--> statement-breakpoint
-- Protection: once set, the recorded-closed time can never change (a later edit of review notes
-- must not make an old loss look like it happened today).
CREATE TRIGGER `trades_closed_recorded_frozen` BEFORE UPDATE OF `closed_recorded_at` ON `trades`
WHEN OLD.`closed_recorded_at` IS NOT NULL AND NEW.`closed_recorded_at` IS NOT OLD.`closed_recorded_at`
BEGIN
  SELECT RAISE(ABORT, 'closed_recorded_at cannot be changed once it is set');
END;--> statement-breakpoint
-- Protection: a closed trade must have it (SQLite cannot add a CHECK to an existing table).
CREATE TRIGGER `trades_closed_recorded_required_insert` BEFORE INSERT ON `trades`
WHEN NEW.`status` = 'closed'
  AND (NEW.`closed_recorded_at` IS NULL OR length(NEW.`closed_recorded_at`) = 0)
BEGIN
  SELECT RAISE(ABORT, 'closed trades need a closed_recorded_at');
END;--> statement-breakpoint
CREATE TRIGGER `trades_closed_recorded_required_update` BEFORE UPDATE OF `status`, `closed_recorded_at` ON `trades`
WHEN NEW.`status` = 'closed'
  AND (NEW.`closed_recorded_at` IS NULL OR length(NEW.`closed_recorded_at`) = 0)
BEGIN
  SELECT RAISE(ABORT, 'closed trades need a closed_recorded_at');
END;--> statement-breakpoint
-- Append-only logs: rows can be added, never changed or removed.
CREATE TRIGGER `risk_events_no_update` BEFORE UPDATE ON `risk_events`
BEGIN
  SELECT RAISE(ABORT, 'risk_events is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `risk_events_no_delete` BEFORE DELETE ON `risk_events`
BEGIN
  SELECT RAISE(ABORT, 'risk_events is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `risk_verdicts_no_update` BEFORE UPDATE ON `risk_verdicts`
BEGIN
  SELECT RAISE(ABORT, 'risk_verdicts is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `risk_verdicts_no_delete` BEFORE DELETE ON `risk_verdicts`
BEGIN
  SELECT RAISE(ABORT, 'risk_verdicts is append-only');
END;
