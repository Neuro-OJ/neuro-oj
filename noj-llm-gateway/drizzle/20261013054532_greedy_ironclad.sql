ALTER TABLE "llm_providers" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_quotas" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_revision_check" CHECK ("llm_providers"."revision" >= 1);--> statement-breakpoint
ALTER TABLE "llm_quotas" ADD CONSTRAINT "llm_quotas_revision_check" CHECK ("llm_quotas"."revision" >= 1);