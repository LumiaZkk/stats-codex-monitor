CREATE TABLE `protocol_methods` (
	`owner` text NOT NULL,
	`method` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `protocol_owner_method` ON `protocol_methods` (`owner`,`method`);--> statement-breakpoint
CREATE TABLE `diagnostic_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_json` text NOT NULL,
	`request_hash` text NOT NULL,
	`event_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`cancelled` integer DEFAULT 0 NOT NULL,
	`plan_json` text,
	`plan_hash` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `request_owner_idempotency` ON `diagnostic_requests` (`owner`,`idempotency_key`);