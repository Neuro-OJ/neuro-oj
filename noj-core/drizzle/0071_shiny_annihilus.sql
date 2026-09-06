ALTER TABLE "contests" ADD COLUMN "ranking_visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "contests" ADD COLUMN "freeze_start_time" text;--> statement-breakpoint
ALTER TABLE "contests" ADD COLUMN "freeze_duration_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_ranking_visibility_check" CHECK ("contests"."ranking_visibility" IN ('public', 'participants', 'hidden'));--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_freeze_duration_check" CHECK ("contests"."freeze_duration_seconds" >= 0);