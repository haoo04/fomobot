CREATE TABLE `administrators` (
	`id` integer PRIMARY KEY,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT "administrators_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `secret_store` (
	`id` text PRIMARY KEY NOT NULL,
	`cipher_text` text NOT NULL,
	`nonce` text NOT NULL,
	`auth_tag` text NOT NULL,
	`algorithm` text NOT NULL,
	`key_version` integer NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`administrator_id` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	CONSTRAINT `fk_sessions_administrator_id_administrators_id_fk` FOREIGN KEY (`administrator_id`) REFERENCES `administrators`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `sessions_expiration` ON `sessions` (`expires_at_ms`);