ALTER TABLE "llm_usage" ADD COLUMN "principal_type" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "principal_id" text;--> statement-breakpoint
CREATE INDEX "idx_llm_usage_principal" ON "llm_usage" USING btree ("domain_id","principal_type","principal_id","created_at");