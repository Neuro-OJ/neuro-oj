ALTER TABLE "assignments" DROP CONSTRAINT "assignments_schedule_check";--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "scheduled_by" text;--> statement-breakpoint
UPDATE "assignments" SET "scheduled_by" = "created_by" WHERE "state" = 'scheduled';--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_scheduled_by_users_id_fk" FOREIGN KEY ("scheduled_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_schedule_check" CHECK ("assignments"."state" <> 'scheduled' OR ("assignments"."publish_at" IS NOT NULL AND "assignments"."scheduled_by" IS NOT NULL));
