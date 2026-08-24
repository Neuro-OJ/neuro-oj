CREATE TABLE "llm_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text DEFAULT '0' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_quotas" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"window_type" text DEFAULT 'day' NOT NULL,
	"max_calls" integer DEFAULT 0 NOT NULL,
	"max_tokens" integer DEFAULT 0 NOT NULL,
	"max_cost" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_id" text NOT NULL,
	"problem_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"request_messages" jsonb NOT NULL,
	"request_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"error_code" text,
	"prompt_hash" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "llm_config" jsonb;--> statement-breakpoint
CREATE INDEX "idx_llm_providers_name" ON "llm_providers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_llm_quotas_scope" ON "llm_quotas" USING btree ("scope_type","scope_id","window_type");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_submission_id" ON "llm_usage" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_problem_id" ON "llm_usage" USING btree ("problem_id");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_user_id" ON "llm_usage" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_provider_id" ON "llm_usage" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_created_at" ON "llm_usage" USING btree ("created_at");