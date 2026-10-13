CREATE TABLE "domain_llm_settings" (
	"domain_id" text PRIMARY KEY NOT NULL,
	"provider_id" text,
	"model" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "domain_llm_settings_revision_check" CHECK ("domain_llm_settings"."revision" >= 1),
	CONSTRAINT "domain_llm_settings_selection_check" CHECK (("domain_llm_settings"."provider_id" IS NULL AND "domain_llm_settings"."model" IS NULL) OR (length(trim("domain_llm_settings"."provider_id")) > 0 AND length(trim("domain_llm_settings"."model")) > 0))
);
--> statement-breakpoint
ALTER TABLE "contest_problems" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "contest_problems" ADD COLUMN "domain_problem_binding_id" text;--> statement-breakpoint
ALTER TABLE "contests" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "domain_llm_settings" ADD CONSTRAINT "domain_llm_settings_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_workspace_contest_fk" FOREIGN KEY ("domain_id","contest_id") REFERENCES "contests"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_workspace_binding_fk" FOREIGN KEY ("domain_id","domain_problem_binding_id") REFERENCES "domain_problem_bindings"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_binding_problem_fk" FOREIGN KEY ("domain_problem_binding_id","problem_id") REFERENCES "domain_problem_bindings"("id","problem_id") ON DELETE no action ON UPDATE no action;
