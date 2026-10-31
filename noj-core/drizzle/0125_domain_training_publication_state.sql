ALTER TABLE "trainings" ADD COLUMN "state" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
UPDATE "trainings" SET "state" = 'published' WHERE "visibility" IN ('public', 'unlisted');--> statement-breakpoint
ALTER TABLE "trainings" ADD CONSTRAINT "trainings_state_check" CHECK ("trainings"."state" IN ('draft', 'published'));