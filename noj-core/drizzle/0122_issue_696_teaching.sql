ALTER TABLE "classroom_assistant_grants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "classroom_assistant_grants" CASCADE;--> statement-breakpoint
ALTER TABLE "classroom_memberships" DROP CONSTRAINT "classroom_memberships_role_check";--> statement-breakpoint
ALTER TABLE "classrooms" DROP CONSTRAINT "classrooms_primary_coach_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "classrooms" DROP CONSTRAINT "classrooms_coach_domain_fk";
--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "submission_source" text DEFAULT 'domain_any' NOT NULL;--> statement-breakpoint
ALTER TABLE "classrooms" DROP COLUMN "primary_coach_id";--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_submission_source_check" CHECK ("assignments"."submission_source" IN ('assignment_only', 'domain_any') AND ("assignments"."submission_source" = 'domain_any' OR NOT "assignments"."include_previous_submissions"));--> statement-breakpoint
DELETE FROM "classroom_memberships" WHERE "classroom_memberships"."role" <> 'student';--> statement-breakpoint
ALTER TABLE "classroom_memberships" ADD CONSTRAINT "classroom_memberships_role_check" CHECK ("classroom_memberships"."role" IN ('student'));