-- 清理/废弃旧赛制竞赛数据（icpc/ioi/oi），统一为类 Kaggle 赛制
DELETE FROM contest_clarifications WHERE contest_id IN (SELECT id FROM contests WHERE type <> 'kaggle');--> statement-breakpoint
DELETE FROM contest_participants WHERE contest_id IN (SELECT id FROM contests WHERE type <> 'kaggle');--> statement-breakpoint
DELETE FROM contest_problems WHERE contest_id IN (SELECT id FROM contests WHERE type <> 'kaggle');--> statement-breakpoint
DELETE FROM objective_submissions WHERE contest_id IN (SELECT id FROM contests WHERE type <> 'kaggle');--> statement-breakpoint
UPDATE submissions SET contest_id = NULL WHERE contest_id IN (SELECT id FROM contests WHERE type <> 'kaggle');--> statement-breakpoint
DELETE FROM contests WHERE type <> 'kaggle';--> statement-breakpoint
ALTER TABLE "contests" DROP CONSTRAINT "contests_type_check";--> statement-breakpoint
ALTER TABLE "contest_problems" ALTER COLUMN "score" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "submission_mode" text DEFAULT 'code' NOT NULL;--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "artifact_max_size_mb" integer;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "artifact_storage_url" text;--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_type_check" CHECK ("contests"."type" IN ('kaggle'));--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_submission_mode_check" CHECK ("problems"."submission_mode" IN ('code', 'artifact'));