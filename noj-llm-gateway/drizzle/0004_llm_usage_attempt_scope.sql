-- 版本化评测：LLM 用量按「评测尝试」归属（同一提交可多次评测）
ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "attempt_id" text;
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "problem_version_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_attempt_id" ON "llm_usage" ("attempt_id");
