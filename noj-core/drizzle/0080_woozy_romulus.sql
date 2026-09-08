ALTER TABLE "community_reports" ADD COLUMN "updated_at" text NOT NULL;--> statement-breakpoint
ALTER TABLE "community_sanctions" ADD COLUMN "updated_at" text NOT NULL;--> statement-breakpoint
ALTER TABLE "ip_bans" ADD COLUMN "updated_at" text NOT NULL;--> statement-breakpoint
ALTER TABLE "user_bans" ADD COLUMN "updated_at" text NOT NULL;