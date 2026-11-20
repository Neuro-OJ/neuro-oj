CREATE TABLE "llm_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"day_max_calls" integer,
	"day_max_tokens" integer,
	"day_max_cost" integer,
	"month_max_calls" integer,
	"month_max_tokens" integer,
	"month_max_cost" integer,
	"updated_at" text NOT NULL,
	CONSTRAINT "llm_policy_revision_check" CHECK ("llm_policy"."revision" >= 0),
	CONSTRAINT "llm_policy_non_negative_check" CHECK (("llm_policy"."day_max_calls" IS NULL OR "llm_policy"."day_max_calls" >= 0)
        AND ("llm_policy"."day_max_tokens" IS NULL OR "llm_policy"."day_max_tokens" >= 0)
        AND ("llm_policy"."day_max_cost" IS NULL OR "llm_policy"."day_max_cost" >= 0)
        AND ("llm_policy"."month_max_calls" IS NULL OR "llm_policy"."month_max_calls" >= 0)
        AND ("llm_policy"."month_max_tokens" IS NULL OR "llm_policy"."month_max_tokens" >= 0)
        AND ("llm_policy"."month_max_cost" IS NULL OR "llm_policy"."month_max_cost" >= 0))
);
--> statement-breakpoint
CREATE TABLE "llm_policy_operations" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"request_digest" text NOT NULL,
	"expected_revision" integer NOT NULL,
	"result_revision" integer,
	"status" text NOT NULL,
	"error_code" text,
	"result" jsonb,
	"actor_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "llm_policy_operations_status_check" CHECK ("llm_policy_operations"."status" IN ('applied', 'rejected', 'conflict'))
);
--> statement-breakpoint
-- 注意：drizzle-kit 依据 journal 快照重复生成了 llm_providers.rpm_limit / tpm_limit
-- 的 ADD COLUMN。这两列由历史 manifest 0005_provider_rate_limits.sql 添加，且
-- readGatewayMigrationPlan 固定「历史 manifest → journal」顺序执行，因此任何环境
-- 执行到本文件时列都已存在。保留该 ALTER 会在空库和存量库都报 duplicate column，
-- 所以这里只保留新增政策表，不重复添加历史列。
CREATE INDEX "idx_llm_policy_operations_created" ON "llm_policy_operations" USING btree ("created_at");