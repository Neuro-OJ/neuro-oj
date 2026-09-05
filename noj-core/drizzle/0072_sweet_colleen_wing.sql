ALTER TABLE "contests" ADD COLUMN "kind" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_kind_check" CHECK ("contests"."kind" IN ('public', 'invite'));--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_visibility_check" CHECK ("problems"."visibility" IN ('public', 'private'));