CREATE TABLE `system_events` (
	`id` integer PRIMARY KEY,
	`source` text NOT NULL,
	`code` text NOT NULL,
	`state` text NOT NULL,
	`severity` text NOT NULL,
	`detail_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`dedupe_key` text UNIQUE
);
--> statement-breakpoint
ALTER TABLE `outbox_messages` ADD `system_event_id` integer REFERENCES system_events(id);--> statement-breakpoint
ALTER TABLE `telegram_settings` ADD `system_alerts_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `outbox_system_event` ON `outbox_messages` (`system_event_id`);--> statement-breakpoint
CREATE INDEX `outbox_sent_at` ON `outbox_messages` (`sent_at_ms`);--> statement-breakpoint
CREATE INDEX `system_events_recent` ON `system_events` (`created_at_ms`,`id`);--> statement-breakpoint
CREATE INDEX `system_events_source_code` ON `system_events` (`source`,`code`,`created_at_ms`);