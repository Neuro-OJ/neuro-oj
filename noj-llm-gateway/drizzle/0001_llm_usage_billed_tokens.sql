ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "cached_prompt_tokens" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "billed_prompt_tokens" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "billed_total_tokens" integer NOT NULL DEFAULT 0;
