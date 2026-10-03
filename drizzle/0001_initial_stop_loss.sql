ALTER TABLE `trades` ADD `initial_stop_loss` text;--> statement-breakpoint
-- HAND-WRITTEN PART (drizzle-kit only generated the ADD COLUMN above).
-- Backfill: trades that are already open or closed start with their current stop. If a stop was
-- moved before this migration, the original value is already lost; this is the best available.
UPDATE `trades` SET `initial_stop_loss` = `stop_loss` WHERE `status` IN ('open', 'closed');--> statement-breakpoint
-- Protection: the initial stop can never change once set. (Text comparison on purpose: it must be
-- exactly the same string, no numeric conversion.)
CREATE TRIGGER `trades_initial_stop_frozen` BEFORE UPDATE OF `initial_stop_loss` ON `trades`
WHEN OLD.`initial_stop_loss` IS NOT NULL AND NEW.`initial_stop_loss` IS NOT OLD.`initial_stop_loss`
BEGIN
  SELECT RAISE(ABORT, 'initial_stop_loss cannot be changed once it is set');
END;--> statement-breakpoint
-- Protection: an open or closed trade must have an initial stop (SQLite cannot add a CHECK
-- constraint to an existing table, so triggers do it).
CREATE TRIGGER `trades_initial_stop_required_insert` BEFORE INSERT ON `trades`
WHEN NEW.`status` IN ('open', 'closed')
  AND (NEW.`initial_stop_loss` IS NULL OR length(NEW.`initial_stop_loss`) = 0)
BEGIN
  SELECT RAISE(ABORT, 'open and closed trades need an initial_stop_loss');
END;--> statement-breakpoint
CREATE TRIGGER `trades_initial_stop_required_update` BEFORE UPDATE OF `status`, `initial_stop_loss` ON `trades`
WHEN NEW.`status` IN ('open', 'closed')
  AND (NEW.`initial_stop_loss` IS NULL OR length(NEW.`initial_stop_loss`) = 0)
BEGIN
  SELECT RAISE(ABORT, 'open and closed trades need an initial_stop_loss');
END;
