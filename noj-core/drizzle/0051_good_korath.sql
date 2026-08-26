ALTER TABLE "announcements" ADD COLUMN "public_id" text;--> statement-breakpoint
ALTER TABLE "community_posts" ADD COLUMN "public_id" text;--> statement-breakpoint
ALTER TABLE "contests" ADD COLUMN "public_id" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "public_id" text;--> statement-breakpoint
ALTER TABLE "trainings" ADD COLUMN "public_id" text;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "trainings" ADD CONSTRAINT "trainings_public_id_unique" UNIQUE("public_id");