CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`mode` text DEFAULT 'paper' NOT NULL,
	`base_currency` text NOT NULL,
	`starting_balance` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "accounts_mode_check" CHECK(mode IN ('paper', 'live'))
);
--> statement-breakpoint
CREATE TABLE `setups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `setups_name_unique` ON `setups` (`name`);--> statement-breakpoint
CREATE TABLE `trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`setup_id` integer,
	`symbol` text NOT NULL,
	`asset_class` text NOT NULL,
	`direction` text NOT NULL,
	`status` text NOT NULL,
	`planned_entry` text NOT NULL,
	`stop_loss` text NOT NULL,
	`take_profit` text,
	`size` text NOT NULL,
	`quote_currency` text NOT NULL,
	`entry_price` text,
	`exit_price` text,
	`fees` text DEFAULT '0' NOT NULL,
	`fees_currency` text NOT NULL,
	`opened_at` text,
	`closed_at` text,
	`plan_notes` text DEFAULT '' NOT NULL,
	`review_notes` text DEFAULT '' NOT NULL,
	`emotion` text DEFAULT '' NOT NULL,
	`screenshot_path` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`setup_id`) REFERENCES `setups`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "trades_direction_check" CHECK(direction IN ('long', 'short')),
	CONSTRAINT "trades_status_check" CHECK(status IN ('planned', 'open', 'closed', 'cancelled')),
	CONSTRAINT "trades_asset_class_check" CHECK(asset_class IN ('crypto', 'forex', 'stock', 'index', 'commodity', 'other')),
	CONSTRAINT "trades_stop_loss_check" CHECK(length(stop_loss) > 0),
	CONSTRAINT "trades_entry_data_check" CHECK(status NOT IN ('open', 'closed') OR (entry_price IS NOT NULL AND opened_at IS NOT NULL)),
	CONSTRAINT "trades_exit_data_check" CHECK(status <> 'closed' OR (exit_price IS NOT NULL AND closed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `trades_account_id_idx` ON `trades` (`account_id`);--> statement-breakpoint
CREATE INDEX `trades_status_idx` ON `trades` (`status`);--> statement-breakpoint
CREATE INDEX `trades_symbol_idx` ON `trades` (`symbol`);--> statement-breakpoint
CREATE INDEX `trades_opened_at_idx` ON `trades` (`opened_at`);