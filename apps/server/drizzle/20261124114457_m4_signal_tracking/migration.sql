CREATE TABLE `signal_events` (
	`id` integer PRIMARY KEY,
	`signal_id` text NOT NULL,
	`event_type` text NOT NULL,
	`event_time_ms` integer NOT NULL,
	`target` integer,
	`price` text,
	`close_pct` real,
	`ambiguous_intrabar` integer DEFAULT false NOT NULL,
	`reason_code` text,
	`candle_json` text,
	CONSTRAINT `fk_signal_events_signal_id_signals_id_fk` FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `signal_outcomes` (
	`signal_id` text PRIMARY KEY,
	`state` text DEFAULT 'ACTIVE' NOT NULL,
	`start_at_ms` integer NOT NULL,
	`deadline_at_ms` integer NOT NULL,
	`next_open_ms` integer NOT NULL,
	`finished_at_ms` integer,
	`observed_bars` integer DEFAULT 0 NOT NULL,
	`waiting_for_data` integer DEFAULT false NOT NULL,
	`gross_r` text,
	`reason_code` text,
	`silent_before_ms` integer NOT NULL,
	`progress_json` text NOT NULL,
	CONSTRAINT `fk_signal_outcomes_signal_id_signals_id_fk` FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `outbox_messages` ADD `kind` text DEFAULT 'TRADE_SIGNAL' NOT NULL;--> statement-breakpoint
UPDATE `outbox_messages` SET `kind` = 'TELEGRAM_TEST' WHERE `signal_id` IS NULL;--> statement-breakpoint
ALTER TABLE `telegram_settings` ADD `signal_updates_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `signal_events_signal_time` ON `signal_events` (`signal_id`,`event_time_ms`);--> statement-breakpoint
CREATE INDEX `signal_outcomes_open` ON `signal_outcomes` (`next_open_ms`) WHERE "signal_outcomes"."finished_at_ms" is null;--> statement-breakpoint
CREATE INDEX `signal_outcomes_state` ON `signal_outcomes` (`state`);
