ALTER TABLE "submissions" ADD COLUMN "llm_provider_config_id" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_llm_provider_config_id_llm_providers_id_fk" FOREIGN KEY ("llm_provider_config_id") REFERENCES "public"."llm_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_submissions_llm_provider_config_id" ON "submissions" USING btree ("llm_provider_config_id");--> statement-breakpoint
