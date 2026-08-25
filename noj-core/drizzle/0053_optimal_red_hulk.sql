ALTER TABLE "announcements" ALTER COLUMN "public_id" SET DEFAULT 'ann-' || substr(md5(random()::text), 1, 8);--> statement-breakpoint
ALTER TABLE "community_posts" ALTER COLUMN "public_id" SET DEFAULT 'post-' || substr(md5(random()::text), 1, 8);--> statement-breakpoint
ALTER TABLE "contests" ALTER COLUMN "public_id" SET DEFAULT 'ct-' || substr(md5(random()::text), 1, 8);--> statement-breakpoint
ALTER TABLE "submissions" ALTER COLUMN "public_id" SET DEFAULT 'sub-' || substr(md5(random()::text), 1, 8);--> statement-breakpoint
ALTER TABLE "trainings" ALTER COLUMN "public_id" SET DEFAULT 'tr-' || substr(md5(random()::text), 1, 8);