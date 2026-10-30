ALTER TABLE "domain_problem_bindings" DROP CONSTRAINT "domain_problem_bindings_policy_check";--> statement-breakpoint
ALTER TABLE "domain_problem_bindings" DROP CONSTRAINT "domain_problem_bindings_required_version_fk";
--> statement-breakpoint
ALTER TABLE "domain_problem_bindings" DROP COLUMN "effective_version_mode";--> statement-breakpoint
ALTER TABLE "domain_problem_bindings" DROP COLUMN "required_version_id";