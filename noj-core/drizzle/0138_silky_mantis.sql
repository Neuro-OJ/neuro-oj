ALTER TABLE "contest_problems" ALTER COLUMN "domain_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contest_problems" ALTER COLUMN "domain_problem_binding_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contests" ALTER COLUMN "domain_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_workspace_contest_fk" FOREIGN KEY ("domain_id","contest_id") REFERENCES "contests"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_workspace_contest_fk" FOREIGN KEY ("domain_id","contest_id") REFERENCES "contests"("domain_id","id") ON DELETE no action ON UPDATE no action;
