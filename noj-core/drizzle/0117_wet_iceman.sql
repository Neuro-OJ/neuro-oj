ALTER TABLE "submission_jobs" DROP CONSTRAINT "submission_jobs_actor_kind_key_unique";--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "domain_problem_binding_id" text;--> statement-breakpoint
ALTER TABLE "self_tests" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "self_tests" ADD COLUMN "domain_problem_binding_id" text;--> statement-breakpoint
ALTER TABLE "submission_job_items" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "submission_job_items" ADD COLUMN "domain_problem_binding_id" text;--> statement-breakpoint
ALTER TABLE "submission_jobs" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "domain_problem_binding_id" text;--> statement-breakpoint
ALTER TABLE "submission_jobs" ADD CONSTRAINT "submission_jobs_domain_id_unique" UNIQUE("domain_id","id");--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_workspace_binding_fk" FOREIGN KEY ("domain_id","domain_problem_binding_id") REFERENCES "domain_problem_bindings"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_binding_problem_fk" FOREIGN KEY ("domain_problem_binding_id","paper_id") REFERENCES "domain_problem_bindings"("id","problem_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_tests" ADD CONSTRAINT "self_tests_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_tests" ADD CONSTRAINT "self_tests_workspace_binding_fk" FOREIGN KEY ("domain_id","domain_problem_binding_id") REFERENCES "domain_problem_bindings"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_tests" ADD CONSTRAINT "self_tests_binding_problem_fk" FOREIGN KEY ("domain_problem_binding_id","problem_id") REFERENCES "domain_problem_bindings"("id","problem_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_job_items" ADD CONSTRAINT "submission_job_items_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_job_items" ADD CONSTRAINT "submission_job_items_workspace_job_fk" FOREIGN KEY ("domain_id","job_id") REFERENCES "submission_jobs"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_job_items" ADD CONSTRAINT "submission_job_items_workspace_binding_fk" FOREIGN KEY ("domain_id","domain_problem_binding_id") REFERENCES "domain_problem_bindings"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_job_items" ADD CONSTRAINT "submission_job_items_binding_problem_fk" FOREIGN KEY ("domain_problem_binding_id","problem_id") REFERENCES "domain_problem_bindings"("id","problem_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_jobs" ADD CONSTRAINT "submission_jobs_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_workspace_binding_fk" FOREIGN KEY ("domain_id","domain_problem_binding_id") REFERENCES "domain_problem_bindings"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_binding_problem_fk" FOREIGN KEY ("domain_problem_binding_id","problem_id") REFERENCES "domain_problem_bindings"("id","problem_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_objective_submissions_domain_user_paper" ON "objective_submissions" USING btree ("domain_id","user_id","paper_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_self_tests_domain_user_created" ON "self_tests" USING btree ("domain_id","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_jobs_legacy_actor_kind_key_unique" ON "submission_jobs" USING btree ("actor_id","kind","idempotency_key") WHERE "submission_jobs"."domain_id" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_submissions_domain_user_created" ON "submissions" USING btree ("domain_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_submissions_domain_problem_user" ON "submissions" USING btree ("domain_id","problem_id","user_id");--> statement-breakpoint
ALTER TABLE "submission_jobs" ADD CONSTRAINT "submission_jobs_domain_actor_kind_key_unique" UNIQUE("domain_id","actor_id","kind","idempotency_key");
