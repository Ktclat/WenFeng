CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`author` text DEFAULT '' NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`original_share` text DEFAULT '' NOT NULL,
	`category` text DEFAULT '未分类' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`starred` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `notes_user_updated_idx` ON `notes` (`user_id`,`updated_at`);