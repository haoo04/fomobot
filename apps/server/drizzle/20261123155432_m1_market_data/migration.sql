CREATE TABLE `candles` (
	`market_id` text NOT NULL,
	`timeframe` text NOT NULL,
	`open_time_ms` integer NOT NULL,
	`close_time_ms` integer NOT NULL,
	`open` text NOT NULL,
	`high` text NOT NULL,
	`low` text NOT NULL,
	`close` text NOT NULL,
	`base_volume` text,
	`quote_turnover` text,
	`is_closed` integer NOT NULL,
	`source` text NOT NULL,
	`quality_json` text NOT NULL,
	CONSTRAINT `candles_pk` PRIMARY KEY(`market_id`, `timeframe`, `open_time_ms`),
	CONSTRAINT `fk_candles_market_id_markets_id_fk` FOREIGN KEY (`market_id`) REFERENCES `markets`(`id`),
	CONSTRAINT "candles_closed" CHECK("is_closed" = 1)
);
--> statement-breakpoint
CREATE TABLE `markets` (
	`id` text PRIMARY KEY NOT NULL,
	`exchange` text NOT NULL,
	`market_type` text NOT NULL,
	`product_type` text NOT NULL,
	`venue` text NOT NULL,
	`native_symbol` text NOT NULL,
	`base_asset` text NOT NULL,
	`quote_asset` text,
	`collateral_asset` text,
	`instrument_type` text,
	`status` text NOT NULL,
	`exchange_status` text NOT NULL,
	`stale` integer NOT NULL,
	`is_reality` integer NOT NULL,
	`is_rwa` integer,
	`price_precision` integer,
	`tick_size` text,
	`capabilities_json` text NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `monitor_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`market_id` text NOT NULL,
	`trigger_tf` text NOT NULL,
	`confirm_tf` text NOT NULL,
	`trend_tf` text NOT NULL,
	`extra_json` text NOT NULL,
	`enabled` integer NOT NULL,
	CONSTRAINT `fk_monitor_configs_market_id_markets_id_fk` FOREIGN KEY (`market_id`) REFERENCES `markets`(`id`)
);
--> statement-breakpoint
CREATE TABLE `oi_snapshots` (
	`market_id` text NOT NULL,
	`time_ms` integer NOT NULL,
	`series` text NOT NULL,
	`value` text NOT NULL,
	`unit` text NOT NULL,
	`unit_details` text NOT NULL,
	`source` text NOT NULL,
	`quality_json` text NOT NULL,
	CONSTRAINT `oi_snapshots_pk` PRIMARY KEY(`market_id`, `time_ms`, `series`),
	CONSTRAINT `fk_oi_snapshots_market_id_markets_id_fk` FOREIGN KEY (`market_id`) REFERENCES `markets`(`id`)
);
--> statement-breakpoint
CREATE TABLE `quotes` (
	`market_id` text PRIMARY KEY NOT NULL,
	`quote_json` text NOT NULL,
	CONSTRAINT `fk_quotes_market_id_markets_id_fk` FOREIGN KEY (`market_id`) REFERENCES `markets`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `markets_identity` ON `markets` (`exchange`,`market_type`,`product_type`,`venue`,`native_symbol`);--> statement-breakpoint
CREATE UNIQUE INDEX `monitors_market` ON `monitor_configs` (`market_id`);