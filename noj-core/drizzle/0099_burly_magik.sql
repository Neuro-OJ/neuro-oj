ALTER TABLE "self_tests" ADD COLUMN "judge_run_id" text;--> statement-breakpoint
ALTER TABLE "self_tests" ADD COLUMN "judge_progress" jsonb;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "judge_run_id" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "judge_progress" jsonb;