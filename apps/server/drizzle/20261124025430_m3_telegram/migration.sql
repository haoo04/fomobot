CREATE TABLE `outbox_messages` (
	`id` text PRIMARY KEY,
	`dedupe_key` text NOT NULL UNIQUE,
	`signal_id` text,
	`pairing_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`body` text NOT NULL,
	`manual` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`send_day` text,
	`sent_at_ms` integer,
	`telegram_message_id` text,
	`last_error` text,
	CONSTRAINT `fk_outbox_messages_signal_id_signals_id_fk` FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`)
);
--> statement-breakpoint
CREATE TABLE `signals` (
	`id` text PRIMARY KEY,
	`candidate_id` text NOT NULL UNIQUE,
	`levels_json` text NOT NULL,
	`approved_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	CONSTRAINT `fk_signals_candidate_id_signal_candidates_id_fk` FOREIGN KEY (`candidate_id`) REFERENCES `signal_candidates`(`id`)
);
--> statement-breakpoint
CREATE TABLE `telegram_settings` (
	`id` integer PRIMARY KEY,
	`token_ref` text,
	`bot_fingerprint` text,
	`bot_username` text,
	`pairing_id` text,
	`chat_id` text,
	`code_hash` text,
	`code_expires_at_ms` integer,
	`update_offset` integer,
	`pairing_error` text,
	`market_daily_limit` integer DEFAULT 8 NOT NULL,
	`global_daily_limit` integer DEFAULT 30 NOT NULL,
	CONSTRAINT `fk_telegram_settings_token_ref_secret_store_id_fk` FOREIGN KEY (`token_ref`) REFERENCES `secret_store`(`id`),
	CONSTRAINT "telegram_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
ALTER TABLE `risk_evaluations` ADD `evaluated_at_ms` integer;--> statement-breakpoint
ALTER TABLE `risk_evaluations` ADD `quote_json` text;--> statement-breakpoint
ALTER TABLE `signal_candidates` ADD `delivery_pending` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `outbox_due` ON `outbox_messages` (`status`,`next_attempt_ms`);--> statement-breakpoint
CREATE INDEX `outbox_signal` ON `outbox_messages` (`signal_id`);--> statement-breakpoint
CREATE INDEX `outbox_send_day` ON `outbox_messages` (`send_day`);--> statement-breakpoint
CREATE INDEX `candidates_delivery_pending` ON `signal_candidates` (`trigger_close_ms`) WHERE "signal_candidates"."delivery_pending" = 1;