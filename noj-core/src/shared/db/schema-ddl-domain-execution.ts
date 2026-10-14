/** 使用域 LLM 与比赛绑定扩展，保持与追加迁移一致。 */
export const DOMAIN_EXECUTION_DDL: string[] = [
  'ALTER TABLE "submissions" ADD CONSTRAINT "submissions_workspace_contest_fk" FOREIGN KEY ("domain_id","contest_id") REFERENCES "contests"("domain_id","id") ON DELETE no action ON UPDATE no action',
  'ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_workspace_contest_fk" FOREIGN KEY ("domain_id","contest_id") REFERENCES "contests"("domain_id","id") ON DELETE no action ON UPDATE no action',
  'CREATE TABLE "domain_llm_settings" (\n\t"domain_id" text PRIMARY KEY NOT NULL,\n\t"provider_id" text,\n\t"model" text,\n\t"revision" integer DEFAULT 1 NOT NULL,\n\t"updated_at" text NOT NULL,\n\tCONSTRAINT "domain_llm_settings_revision_check" CHECK ("domain_llm_settings"."revision" >= 1),\n\tCONSTRAINT "domain_llm_settings_selection_check" CHECK (("domain_llm_settings"."provider_id" IS NULL AND "domain_llm_settings"."model" IS NULL) OR (length(trim("domain_llm_settings"."provider_id")) > 0 AND length(trim("domain_llm_settings"."model")) > 0))\n);',
  'ALTER TABLE "domain_llm_settings" ADD CONSTRAINT "domain_llm_settings_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_workspace_contest_fk" FOREIGN KEY ("domain_id","contest_id") REFERENCES "contests"("domain_id","id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_workspace_binding_fk" FOREIGN KEY ("domain_id","domain_problem_binding_id") REFERENCES "domain_problem_bindings"("domain_id","id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_binding_problem_fk" FOREIGN KEY ("domain_problem_binding_id","problem_id") REFERENCES "domain_problem_bindings"("id","problem_id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "domain_llm_settings" DROP CONSTRAINT "domain_llm_settings_selection_check";',
  'ALTER TABLE "domain_llm_settings" ADD CONSTRAINT "domain_llm_settings_selection_check" CHECK (("domain_llm_settings"."provider_id" IS NULL AND "domain_llm_settings"."model" IS NULL) OR ("domain_llm_settings"."provider_id" IS NOT NULL AND "domain_llm_settings"."model" IS NOT NULL AND length(trim("domain_llm_settings"."provider_id")) > 0 AND length(trim("domain_llm_settings"."model")) > 0));',
];

/** 测试重置清单包含域模型配置。 */
export const DOMAIN_EXECUTION_TABLES = ["domain_llm_settings"] as const;
