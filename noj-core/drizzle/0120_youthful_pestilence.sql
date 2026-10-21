CREATE TABLE "background_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"task_type" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"dedupe_key" text DEFAULT '' NOT NULL,
	"payload_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"available_at" text NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_owner" text,
	"lease_expiry" text,
	"last_result" jsonb,
	"last_error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"finished_at" text,
	CONSTRAINT "background_tasks_dedupe_unique" UNIQUE("task_type","target_kind","target_id","dedupe_key"),
	CONSTRAINT "background_tasks_status_check" CHECK ("background_tasks"."status" IN ('pending', 'leased', 'succeeded', 'failed')),
	CONSTRAINT "background_tasks_failure_count_check" CHECK ("background_tasks"."failure_count" >= 0),
	CONSTRAINT "background_tasks_payload_version_check" CHECK ("background_tasks"."payload_version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "idx_background_tasks_claim" ON "background_tasks" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "idx_background_tasks_target" ON "background_tasks" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE INDEX "idx_background_tasks_lease" ON "background_tasks" USING btree ("status","lease_expiry");