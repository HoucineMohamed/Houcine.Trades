CREATE TABLE `auth_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bucket` text NOT NULL,
	`kind` text NOT NULL,
	`at_ms` integer NOT NULL,
	CONSTRAINT "auth_attempts_kind_check" CHECK(kind IN ('login', 'step_up'))
);
--> statement-breakpoint
CREATE INDEX `auth_attempts_bucket_idx` ON `auth_attempts` (bucket,at_ms);--> statement-breakpoint
CREATE TABLE `auth_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL,
	`session_id` integer,
	`ip` text DEFAULT '' NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "auth_events_kind_check" CHECK(kind IN ('owner_created', 'owner_reset', 'login_success', 'login_failure', 'recovery_used', 'step_up_success', 'step_up_failure', 'logout', 'logout_all', 'session_revoked', 'password_changed', 'recovery_regenerated', 'rate_limit_tripped'))
);
--> statement-breakpoint
CREATE TABLE `owner` (
	`id` integer PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`totp_secret_enc` text NOT NULL,
	`totp_last_step` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`password_changed_at` text NOT NULL,
	CONSTRAINT "owner_single_row_check" CHECK(id = 1)
);
--> statement-breakpoint
CREATE TABLE `recovery_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`used_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_codes_code_hash_unique` ON `recovery_codes` (`code_hash`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`step_up_at` text,
	`ip` text DEFAULT '' NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL,
	`revoked_at` text,
	`revoked_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_revoked_at_idx` ON `sessions` (revoked_at);
--> statement-breakpoint
-- HAND-WRITTEN PART (drizzle-kit generated the tables and indexes above).
-- Database-level protections for authentication state. Triggers are not tracked by drizzle-kit:
-- a future migration that rebuilds one of these tables must re-create them (a test lists them).

-- The owner: exactly one row (the CHECK id = 1 above), never deleted, id never changed.
CREATE TRIGGER `owner_no_delete` BEFORE DELETE ON `owner`
BEGIN
  SELECT RAISE(ABORT, 'the owner cannot be deleted');
END;--> statement-breakpoint
CREATE TRIGGER `owner_id_frozen` BEFORE UPDATE OF `id` ON `owner`
BEGIN
  SELECT RAISE(ABORT, 'the owner id cannot be changed');
END;--> statement-breakpoint
-- The authentication log is append-only.
CREATE TRIGGER `auth_events_no_update` BEFORE UPDATE ON `auth_events`
BEGIN
  SELECT RAISE(ABORT, 'auth_events is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `auth_events_no_delete` BEFORE DELETE ON `auth_events`
BEGIN
  SELECT RAISE(ABORT, 'auth_events is append-only');
END;--> statement-breakpoint
-- Sessions: the token hash and creation time never change, and a revoked session can never be
-- brought back to life. Rows are kept (history), never deleted.
CREATE TRIGGER `sessions_identity_frozen` BEFORE UPDATE OF `token_hash`, `created_at` ON `sessions`
WHEN NEW.`token_hash` IS NOT OLD.`token_hash` OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'a session token hash and creation time cannot be changed');
END;--> statement-breakpoint
CREATE TRIGGER `sessions_revocation_final` BEFORE UPDATE OF `revoked_at` ON `sessions`
WHEN OLD.`revoked_at` IS NOT NULL AND NEW.`revoked_at` IS NOT OLD.`revoked_at`
BEGIN
  SELECT RAISE(ABORT, 'a revoked session cannot be restored');
END;--> statement-breakpoint
CREATE TRIGGER `sessions_no_delete` BEFORE DELETE ON `sessions`
BEGIN
  SELECT RAISE(ABORT, 'sessions are kept for the audit trail');
END;--> statement-breakpoint
-- Recovery codes work ONCE: used_at can never be cleared or changed, the hash never changes, and
-- rows are never deleted.
CREATE TRIGGER `recovery_codes_use_final` BEFORE UPDATE OF `used_at` ON `recovery_codes`
WHEN OLD.`used_at` IS NOT NULL AND NEW.`used_at` IS NOT OLD.`used_at`
BEGIN
  SELECT RAISE(ABORT, 'a used recovery code cannot be made valid again');
END;--> statement-breakpoint
CREATE TRIGGER `recovery_codes_hash_frozen` BEFORE UPDATE OF `code_hash` ON `recovery_codes`
WHEN NEW.`code_hash` IS NOT OLD.`code_hash`
BEGIN
  SELECT RAISE(ABORT, 'a recovery code hash cannot be changed');
END;--> statement-breakpoint
CREATE TRIGGER `recovery_codes_no_delete` BEFORE DELETE ON `recovery_codes`
BEGIN
  SELECT RAISE(ABORT, 'recovery codes are kept for the audit trail');
END;
