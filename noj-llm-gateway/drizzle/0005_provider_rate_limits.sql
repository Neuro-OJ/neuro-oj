-- Provider 级上游速率上限（0 = 不限）：超过时 gateway 排队等待而非直接失败
ALTER TABLE "llm_providers" ADD COLUMN IF NOT EXISTS "rpm_limit" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "llm_providers" ADD COLUMN IF NOT EXISTS "tpm_limit" integer DEFAULT 0 NOT NULL;
