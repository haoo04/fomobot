CREATE TABLE `risk_evaluations` (
	`candidate_id` text NOT NULL,
	`stage` text NOT NULL,
	`outcome` text NOT NULL,
	`reason_code` text,
	`levels_json` text,
	CONSTRAINT `risk_evaluations_pk` PRIMARY KEY(`candidate_id`, `stage`),
	CONSTRAINT `fk_risk_evaluations_candidate_id_signal_candidates_id_fk` FOREIGN KEY (`candidate_id`) REFERENCES `signal_candidates`(`id`)
);
--> statement-breakpoint
CREATE TABLE `signal_candidates` (
	`id` text PRIMARY KEY,
	`idempotency_key` text NOT NULL,
	`market_id` text NOT NULL,
	`strategy_config_version_id` text NOT NULL,
	`trigger_tf` text NOT NULL,
	`trigger_open_ms` integer NOT NULL,
	`trigger_close_ms` integer NOT NULL,
	`direction` text NOT NULL,
	`evaluated_at_ms` integer NOT NULL,
	`evidence_json` text NOT NULL,
	CONSTRAINT `fk_signal_candidates_market_id_markets_id_fk` FOREIGN KEY (`market_id`) REFERENCES `markets`(`id`),
	CONSTRAINT `fk_signal_candidates_strategy_config_version_id_strategy_config_versions_id_fk` FOREIGN KEY (`strategy_config_version_id`) REFERENCES `strategy_config_versions`(`id`)
);
--> statement-breakpoint
CREATE TABLE `strategy_config_versions` (
	`id` text PRIMARY KEY,
	`strategy_id` text NOT NULL,
	`strategy_version` text NOT NULL,
	`algorithm_version` text NOT NULL,
	`config_hash` text NOT NULL,
	`params_json` text NOT NULL,
	`timeframes_json` text NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `monitor_configs` ADD `strategy_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `monitor_configs` ADD `strategy_config_version_id` text REFERENCES strategy_config_versions(id);--> statement-breakpoint
ALTER TABLE `monitor_configs` ADD `strategy_after_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `candidates_idempotency` ON `signal_candidates` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `candidates_market_trigger` ON `signal_candidates` (`market_id`,`trigger_tf`,`trigger_close_ms`);--> statement-breakpoint
CREATE INDEX `candidates_recent` ON `signal_candidates` (`evaluated_at_ms`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `strategy_configs_hash` ON `strategy_config_versions` (`config_hash`);