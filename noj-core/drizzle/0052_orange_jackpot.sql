ALTER TABLE "announcements" ALTER COLUMN "public_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "community_posts" ALTER COLUMN "public_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contests" ALTER COLUMN "public_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ALTER COLUMN "public_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "trainings" ALTER COLUMN "public_id" SET NOT NULL;