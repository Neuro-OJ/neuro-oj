CREATE TABLE "evaluation_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_id" text,
	"objective_submission_id" text,
	"problem_id" text NOT NULL,
	"problem_version_id" text,
	"sequence" integer NOT NULL,
	"source" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"result_kind" text,
	"result_status" text,
	"score" integer,
	"accepted" boolean DEFAULT false NOT NULL,
	"output" text DEFAULT '' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"time_ms" integer,
	"memory_kb" integer,
	"task_snapshot" jsonb,
	"created_by" text,
	"created_at" text NOT NULL,
	"started_at" text,
	"finished_at" text,
	CONSTRAINT "evaluation_attempts_submission_sequence_unique" UNIQUE("submission_id","sequence"),
	CONSTRAINT "evaluation_attempts_objective_sequence_unique" UNIQUE("objective_submission_id","sequence"),
	CONSTRAINT "evaluation_attempts_source_check" CHECK (("evaluation_attempts"."submission_id" IS NULL) <> ("evaluation_attempts"."objective_submission_id" IS NULL)),
	CONSTRAINT "evaluation_attempts_state_check" CHECK ("evaluation_attempts"."state" IN ('queued', 'judging', 'finished', 'error', 'superseded')),
	CONSTRAINT "evaluation_attempts_source_kind_check" CHECK ("evaluation_attempts"."source" IN ('initial', 'rejudge', 'upgrade', 'legacy_import')),
	CONSTRAINT "evaluation_attempts_result_kind_check" CHECK ("evaluation_attempts"."result_kind" IS NULL OR "evaluation_attempts"."result_kind" IN ('graded', 'platform_error')),
	CONSTRAINT "evaluation_attempts_sequence_check" CHECK ("evaluation_attempts"."sequence" >= 0),
	CONSTRAINT "evaluation_attempts_score_check" CHECK ("evaluation_attempts"."score" IS NULL OR ("evaluation_attempts"."score" >= 0 AND "evaluation_attempts"."score" <= 10000)),
	CONSTRAINT "evaluation_attempts_details_check" CHECK (jsonb_typeof("evaluation_attempts"."details") = 'object')
);
--> statement-breakpoint
CREATE TABLE "problem_draft_objects" (
	"problem_id" text NOT NULL,
	"role" text NOT NULL,
	"path" text NOT NULL,
	"storage_url" text NOT NULL,
	CONSTRAINT "problem_draft_objects_pk" PRIMARY KEY("problem_id","role","path"),
	CONSTRAINT "problem_draft_objects_role_check" CHECK ("problem_draft_objects"."role" IN ('support_package', 'oi_file'))
);
--> statement-breakpoint
CREATE TABLE "problem_drafts" (
	"problem_id" text PRIMARY KEY NOT NULL,
	"base_version_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"content" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "problem_drafts_revision_check" CHECK ("problem_drafts"."revision" >= 1),
	CONSTRAINT "problem_drafts_content_check" CHECK (jsonb_typeof("problem_drafts"."content") = 'object')
);
--> statement-breakpoint
CREATE TABLE "problem_version_objects" (
	"version_id" text NOT NULL,
	"role" text NOT NULL,
	"path" text NOT NULL,
	"storage_url" text NOT NULL,
	CONSTRAINT "problem_version_objects_pk" PRIMARY KEY("version_id","role","path"),
	CONSTRAINT "problem_version_objects_role_check" CHECK ("problem_version_objects"."role" IN ('support_package', 'oi_file'))
);
--> statement-breakpoint
CREATE TABLE "problem_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"problem_id" text NOT NULL,
	"version" integer NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"origin" text DEFAULT 'published' NOT NULL,
	"content" jsonb NOT NULL,
	"content_sha256" text,
	"change_note" text DEFAULT '' NOT NULL,
	"published_by" text,
	"published_at" text NOT NULL,
	CONSTRAINT "problem_versions_problem_version_unique" UNIQUE("problem_id","version"),
	CONSTRAINT "problem_versions_problem_id_id_unique" UNIQUE("problem_id","id"),
	CONSTRAINT "problem_versions_version_check" CHECK ("problem_versions"."version" >= 1),
	CONSTRAINT "problem_versions_schema_version_check" CHECK ("problem_versions"."schema_version" >= 1),
	CONSTRAINT "problem_versions_origin_check" CHECK ("problem_versions"."origin" IN ('published', 'migration_baseline')),
	CONSTRAINT "problem_versions_content_check" CHECK (jsonb_typeof("problem_versions"."content") = 'object')
);
--> statement-breakpoint
CREATE TABLE "query_projection_revisions" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"data_revision" bigint DEFAULT 0 NOT NULL,
	"materialized_revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "query_projection_revisions_revision_check" CHECK ("query_projection_revisions"."data_revision" >= 0 AND "query_projection_revisions"."materialized_revision" >= 0 AND "query_projection_revisions"."materialized_revision" <= "query_projection_revisions"."data_revision")
);
--> statement-breakpoint
CREATE TABLE "storage_objects" (
	"storage_url" text PRIMARY KEY NOT NULL,
	"sha256" text,
	"byte_size" bigint,
	"state" text DEFAULT 'unknown' NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "storage_objects_state_check" CHECK ("storage_objects"."state" IN ('unknown', 'ready', 'missing', 'deleting', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "submission_job_items" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"problem_id" text NOT NULL,
	"target_version_id" text,
	"target_version_ref" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_id" text,
	"result_submission_id" text,
	"lease_owner" text,
	"lease_until" text,
	"dispatch_retries" integer DEFAULT 0 NOT NULL,
	"next_dispatch_at" text,
	"reason_code" text,
	"reason_message" text,
	"created_at" text NOT NULL,
	"finished_at" text,
	CONSTRAINT "submission_job_items_job_source_unique" UNIQUE("job_id","source_kind","source_id"),
	CONSTRAINT "submission_job_items_source_kind_check" CHECK ("submission_job_items"."source_kind" IN ('submission', 'objective')),
	CONSTRAINT "submission_job_items_status_check" CHECK ("submission_job_items"."status" IN ('pending', 'preparing', 'dispatched', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT "submission_job_items_ordinal_check" CHECK ("submission_job_items"."ordinal" >= 0),
	CONSTRAINT "submission_job_items_retries_check" CHECK ("submission_job_items"."dispatch_retries" >= 0)
);
--> statement-breakpoint
CREATE TABLE "submission_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" text NOT NULL,
	"finished_at" text,
	CONSTRAINT "submission_jobs_actor_kind_key_unique" UNIQUE("actor_id","kind","idempotency_key"),
	CONSTRAINT "submission_jobs_kind_check" CHECK ("submission_jobs"."kind" IN ('rejudge', 'upgrade')),
	CONSTRAINT "submission_jobs_status_check" CHECK ("submission_jobs"."status" IN ('queued', 'running', 'completed', 'completed_with_errors')),
	CONSTRAINT "submission_jobs_request_check" CHECK (jsonb_typeof("submission_jobs"."request") = 'object')
);
--> statement-breakpoint
CREATE TABLE "submission_version_results" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_id" text,
	"objective_submission_id" text,
	"problem_id" text NOT NULL,
	"problem_version_id" text,
	"current_attempt_id" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "submission_version_results_source_check" CHECK (("submission_version_results"."submission_id" IS NULL) <> ("submission_version_results"."objective_submission_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "contest_problems" ADD COLUMN "pinned_version_id" text;--> statement-breakpoint
ALTER TABLE "contest_problems" ADD COLUMN "effective_version_mode" text DEFAULT 'any' NOT NULL;--> statement-breakpoint
ALTER TABLE "contest_problems" ADD COLUMN "required_version_id" text;--> statement-breakpoint
ALTER TABLE "contest_problems" ADD COLUMN "effective_policy_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "submitted_version_id" text;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "version_origin" text DEFAULT 'legacy_unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "upgraded_from_id" text;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "active_attempt_id" text;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "latest_attempt_id" text;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "is_valid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "is_accepted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "effective_attempt_id" text;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "accepted_attempt_id" text;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "is_contest_valid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "is_contest_accepted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "contest_effective_attempt_id" text;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "contest_accepted_attempt_id" text;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "global_policy_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "contest_policy_revision" integer;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "rejudge_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "latest_version_id" text;--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "effective_version_mode" text DEFAULT 'any' NOT NULL;--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "required_version_id" text;--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "effective_policy_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "self_tests" ADD COLUMN "problem_version_id" text;--> statement-breakpoint
ALTER TABLE "self_tests" ADD COLUMN "task_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "submitted_version_id" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "version_origin" text DEFAULT 'legacy_unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "upgraded_from_id" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "active_attempt_id" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "latest_attempt_id" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "is_valid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "is_accepted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "effective_attempt_id" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "accepted_attempt_id" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "is_contest_valid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "is_contest_accepted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "contest_effective_attempt_id" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "contest_accepted_attempt_id" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "global_policy_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "contest_policy_revision" integer;--> statement-breakpoint
-- 存量迁移（Handbook §8.1 第 4 步）：现有提交保留 submitted_version_id = NULL，
-- 版本来源标记为 legacy_unknown。真实提交时版本不可考，**不得**伪造为迁移基线 V1。
-- 必须位于 version_origin CHECK 约束之前，否则存量行无法通过约束校验。
UPDATE "submissions" SET "version_origin" = 'legacy_unknown' WHERE "submitted_version_id" IS NULL;--> statement-breakpoint
UPDATE "objective_submissions" SET "version_origin" = 'legacy_unknown' WHERE "submitted_version_id" IS NULL;--> statement-breakpoint
ALTER TABLE "evaluation_attempts" ADD CONSTRAINT "evaluation_attempts_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_attempts" ADD CONSTRAINT "evaluation_attempts_objective_submission_id_objective_submissions_id_fk" FOREIGN KEY ("objective_submission_id") REFERENCES "objective_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_attempts" ADD CONSTRAINT "evaluation_attempts_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_attempts" ADD CONSTRAINT "evaluation_attempts_problem_version_id_problem_versions_id_fk" FOREIGN KEY ("problem_version_id") REFERENCES "problem_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_attempts" ADD CONSTRAINT "evaluation_attempts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_draft_objects" ADD CONSTRAINT "problem_draft_objects_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_draft_objects" ADD CONSTRAINT "problem_draft_objects_storage_url_storage_objects_storage_url_fk" FOREIGN KEY ("storage_url") REFERENCES "storage_objects"("storage_url") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_drafts" ADD CONSTRAINT "problem_drafts_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_drafts" ADD CONSTRAINT "problem_drafts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_drafts" ADD CONSTRAINT "problem_drafts_base_version_fk" FOREIGN KEY ("problem_id","base_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_version_objects" ADD CONSTRAINT "problem_version_objects_version_id_problem_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "problem_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_version_objects" ADD CONSTRAINT "problem_version_objects_storage_url_storage_objects_storage_url_fk" FOREIGN KEY ("storage_url") REFERENCES "storage_objects"("storage_url") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_versions" ADD CONSTRAINT "problem_versions_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_versions" ADD CONSTRAINT "problem_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_job_items" ADD CONSTRAINT "submission_job_items_job_id_submission_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "submission_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_job_items" ADD CONSTRAINT "submission_job_items_target_version_id_problem_versions_id_fk" FOREIGN KEY ("target_version_id") REFERENCES "problem_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_job_items" ADD CONSTRAINT "submission_job_items_attempt_id_evaluation_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "evaluation_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_jobs" ADD CONSTRAINT "submission_jobs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_version_results" ADD CONSTRAINT "submission_version_results_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_version_results" ADD CONSTRAINT "submission_version_results_objective_submission_id_objective_submissions_id_fk" FOREIGN KEY ("objective_submission_id") REFERENCES "objective_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_version_results" ADD CONSTRAINT "submission_version_results_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_version_results" ADD CONSTRAINT "submission_version_results_problem_version_id_problem_versions_id_fk" FOREIGN KEY ("problem_version_id") REFERENCES "problem_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_version_results" ADD CONSTRAINT "submission_version_results_current_attempt_id_evaluation_attempts_id_fk" FOREIGN KEY ("current_attempt_id") REFERENCES "evaluation_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_eval_attempts_submission_version_sequence" ON "evaluation_attempts" USING btree ("submission_id","problem_version_id","sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_eval_attempts_objective_version_sequence" ON "evaluation_attempts" USING btree ("objective_submission_id","problem_version_id","sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_eval_attempts_state_created" ON "evaluation_attempts" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "idx_eval_attempts_problem" ON "evaluation_attempts" USING btree ("problem_id");--> statement-breakpoint
CREATE INDEX "idx_problem_draft_objects_storage_url" ON "problem_draft_objects" USING btree ("storage_url");--> statement-breakpoint
CREATE INDEX "idx_problem_version_objects_storage_url" ON "problem_version_objects" USING btree ("storage_url");--> statement-breakpoint
CREATE INDEX "idx_problem_versions_problem_published" ON "problem_versions" USING btree ("problem_id","published_at");--> statement-breakpoint
CREATE INDEX "idx_query_projection_revisions_lagging" ON "query_projection_revisions" USING btree ("data_revision","materialized_revision");--> statement-breakpoint
CREATE INDEX "idx_storage_objects_state" ON "storage_objects" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_storage_objects_sha256" ON "storage_objects" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "idx_submission_job_items_dispatch" ON "submission_job_items" USING btree ("status","next_dispatch_at","lease_until");--> statement-breakpoint
CREATE INDEX "idx_submission_job_items_job_status" ON "submission_job_items" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "idx_submission_jobs_status_created" ON "submission_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_submission_jobs_actor_created" ON "submission_jobs" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_version_results_submission_known_unique" ON "submission_version_results" USING btree ("submission_id","problem_version_id") WHERE "submission_version_results"."submission_id" IS NOT NULL AND "submission_version_results"."problem_version_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "submission_version_results_objective_known_unique" ON "submission_version_results" USING btree ("objective_submission_id","problem_version_id") WHERE "submission_version_results"."objective_submission_id" IS NOT NULL AND "submission_version_results"."problem_version_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "submission_version_results_submission_unknown_unique" ON "submission_version_results" USING btree ("submission_id") WHERE "submission_version_results"."submission_id" IS NOT NULL AND "submission_version_results"."problem_version_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "submission_version_results_objective_unknown_unique" ON "submission_version_results" USING btree ("objective_submission_id") WHERE "submission_version_results"."objective_submission_id" IS NOT NULL AND "submission_version_results"."problem_version_id" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_submission_version_results_problem_version" ON "submission_version_results" USING btree ("problem_id","problem_version_id");--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_pinned_version_fk" FOREIGN KEY ("problem_id","pinned_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_required_version_fk" FOREIGN KEY ("problem_id","required_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_upgraded_from_id_objective_submissions_id_fk" FOREIGN KEY ("upgraded_from_id") REFERENCES "objective_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_submitted_version_fk" FOREIGN KEY ("paper_id","submitted_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_tests" ADD CONSTRAINT "self_tests_problem_version_fk" FOREIGN KEY ("problem_id","problem_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_upgraded_from_id_submissions_id_fk" FOREIGN KEY ("upgraded_from_id") REFERENCES "submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_submitted_version_fk" FOREIGN KEY ("problem_id","submitted_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_objective_submissions_paper_accepted_user" ON "objective_submissions" USING btree ("paper_id","is_accepted","user_id");--> statement-breakpoint
CREATE INDEX "idx_objective_submissions_paper_valid_user" ON "objective_submissions" USING btree ("paper_id","is_valid","user_id");--> statement-breakpoint
CREATE INDEX "idx_objective_submissions_contest_valid_user" ON "objective_submissions" USING btree ("contest_id","paper_id","is_contest_valid","user_id");--> statement-breakpoint
CREATE INDEX "idx_submissions_problem_accepted_user" ON "submissions" USING btree ("problem_id","is_accepted","user_id");--> statement-breakpoint
CREATE INDEX "idx_submissions_problem_valid_user" ON "submissions" USING btree ("problem_id","is_valid","user_id");--> statement-breakpoint
CREATE INDEX "idx_submissions_contest_valid_user" ON "submissions" USING btree ("contest_id","problem_id","is_contest_valid","user_id");--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_effective_version_mode_check" CHECK ("contest_problems"."effective_version_mode" IN ('any', 'exact'));--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_effective_version_policy_check" CHECK (("contest_problems"."effective_version_mode" = 'any' AND "contest_problems"."required_version_id" IS NULL)
        OR ("contest_problems"."effective_version_mode" = 'exact'
            AND "contest_problems"."required_version_id" IS NOT NULL
            AND "contest_problems"."required_version_id" = "contest_problems"."pinned_version_id"));--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_effective_policy_revision_check" CHECK ("contest_problems"."effective_policy_revision" >= 0);--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_version_origin_check" CHECK (("objective_submissions"."version_origin" = 'known' AND "objective_submissions"."submitted_version_id" IS NOT NULL)
        OR ("objective_submissions"."version_origin" = 'legacy_unknown' AND "objective_submissions"."submitted_version_id" IS NULL));--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_effective_version_mode_check" CHECK ("problems"."effective_version_mode" IN ('any', 'exact'));--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_effective_version_policy_check" CHECK (("problems"."effective_version_mode" = 'any' AND "problems"."required_version_id" IS NULL)
        OR ("problems"."effective_version_mode" = 'exact' AND "problems"."required_version_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_effective_policy_revision_check" CHECK ("problems"."effective_policy_revision" >= 0);--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_version_origin_check" CHECK (("submissions"."version_origin" = 'known' AND "submissions"."submitted_version_id" IS NOT NULL)
        OR ("submissions"."version_origin" = 'legacy_unknown' AND "submissions"."submitted_version_id" IS NULL));
-- ============================================================================
-- 手写补充段（drizzle-kit 无法表达的部分；语义与 src/shared/db/schema/*.ts、
-- src/shared/db/schema-ddl.ts 一致，见两侧「故意不在 Drizzle 声明」的注释）
-- ============================================================================

-- 1) 循环外键：`problems` ↔ `problem_versions` 与提交表 ↔ `evaluation_attempts`
--    互为引用，drizzle-kit 的 schema 类型推导无法同时声明两侧，故在此显式建立。
ALTER TABLE "problems" ADD CONSTRAINT "problems_latest_version_fk"
  FOREIGN KEY ("id","latest_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_required_version_fk"
  FOREIGN KEY ("id","required_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_active_attempt_fk"
  FOREIGN KEY ("active_attempt_id") REFERENCES "evaluation_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_latest_attempt_fk"
  FOREIGN KEY ("latest_attempt_id") REFERENCES "evaluation_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_effective_attempt_fk"
  FOREIGN KEY ("effective_attempt_id") REFERENCES "evaluation_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_accepted_attempt_fk"
  FOREIGN KEY ("accepted_attempt_id") REFERENCES "evaluation_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_contest_effective_attempt_fk"
  FOREIGN KEY ("contest_effective_attempt_id") REFERENCES "evaluation_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_contest_accepted_attempt_fk"
  FOREIGN KEY ("contest_accepted_attempt_id") REFERENCES "evaluation_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_active_attempt_fk"
  FOREIGN KEY ("active_attempt_id") REFERENCES "evaluation_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_latest_attempt_fk"
  FOREIGN KEY ("latest_attempt_id") REFERENCES "evaluation_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_effective_attempt_fk"
  FOREIGN KEY ("effective_attempt_id") REFERENCES "evaluation_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_accepted_attempt_fk"
  FOREIGN KEY ("accepted_attempt_id") REFERENCES "evaluation_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_contest_effective_attempt_fk"
  FOREIGN KEY ("contest_effective_attempt_id") REFERENCES "evaluation_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_contest_accepted_attempt_fk"
  FOREIGN KEY ("contest_accepted_attempt_id") REFERENCES "evaluation_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- 2) 已发布版本不可修改（Handbook §2.3「数据库 UPDATE 守卫」）。
--    唯一允许的例外：迁移基线的 content_sha256 由 NULL 回填为实际哈希。
CREATE OR REPLACE FUNCTION noj_problem_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.problem_id IS DISTINCT FROM OLD.problem_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.change_note IS DISTINCT FROM OLD.change_note
     OR NEW.published_by IS DISTINCT FROM OLD.published_by
     OR NEW.published_at IS DISTINCT FROM OLD.published_at
  THEN
    RAISE EXCEPTION 'problem_versions 已发布版本不可修改（id=%）', OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     AND NOT (OLD.content_sha256 IS NULL
              AND NEW.content_sha256 IS NOT NULL
              AND OLD.origin = 'migration_baseline')
  THEN
    RAISE EXCEPTION 'problem_versions 内容哈希不可修改（id=%）', OLD.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER problem_versions_immutable_guard
  BEFORE UPDATE ON "problem_versions"
  FOR EACH ROW EXECUTE FUNCTION noj_problem_versions_immutable();--> statement-breakpoint
