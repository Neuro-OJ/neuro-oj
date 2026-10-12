ALTER TABLE "community_activity_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "community_activity_events" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_community_activity_visibility_check";--> statement-breakpoint
DROP INDEX "idx_submissions_contest_client_ip";--> statement-breakpoint
ALTER TABLE "submissions" DROP COLUMN "client_ip";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "community_activity_visibility";