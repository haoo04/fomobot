CREATE TABLE `ai_reviews` (
	`id` text PRIMARY KEY,
	`candidate_id` text UNIQUE,
	`pairing_id` text,
	`model` text NOT NULL,
	`reported_model` text,
	`prompt_version` text NOT NULL,
	`settings_revision` text NOT NULL,
	`confidence_threshold` integer NOT NULL,
	`status` text NOT NULL,
	`request_summary_json` text NOT NULL,
	`result_json` text,
	`reason_code` text,
	`day` text NOT NULL,
	`reserved_micros` integer NOT NULL,
	`cost_micros` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at_ms` integer NOT NULL,
	`started_at_ms` integer,
	`completed_at_ms` integer,
	CONSTRAINT `fk_ai_reviews_candidate_id_signal_candidates_id_fk` FOREIGN KEY (`candidate_id`) REFERENCES `signal_candidates`(`id`)
);
--> statement-breakpoint
CREATE TABLE `ai_settings` (
	`id` integer PRIMARY KEY,
	`key_ref` text,
	`enabled` integer NOT NULL,
	`model` text NOT NULL,
	`confidence_threshold` integer NOT NULL,
	`daily_budget_micros` integer NOT NULL,
	`timeout_ms` integer NOT NULL,
	`max_output_tokens` integer NOT NULL,
	`revision` text NOT NULL,
	CONSTRAINT `fk_ai_settings_key_ref_secret_store_id_fk` FOREIGN KEY (`key_ref`) REFERENCES `secret_store`(`id`),
	CONSTRAINT "ai_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
ALTER TABLE `signals` ADD `mode` text DEFAULT 'RULE_ONLY' NOT NULL;--> statement-breakpoint
ALTER TABLE `signals` ADD `ai_revision` text;--> statement-breakpoint
CREATE INDEX `ai_reviews_day` ON `ai_reviews` (`day`);