UPDATE "problems" p
SET "effective_version_mode" = b."effective_version_mode",
    "required_version_id" = b."required_version_id",
    "effective_policy_revision" = GREATEST(p."effective_policy_revision", b."revision")
FROM "domain_problem_bindings" b
WHERE b."problem_id" = p."id" AND b."domain_id" = p."domain_id" AND b."kind" = 'owned';--> statement-breakpoint
ALTER TABLE "domain_problem_bindings" DROP CONSTRAINT "domain_problem_bindings_policy_check";--> statement-breakpoint
ALTER TABLE "domain_problem_bindings" DROP CONSTRAINT "domain_problem_bindings_required_version_fk";
--> statement-breakpoint
ALTER TABLE "domain_problem_bindings" DROP COLUMN "effective_version_mode";--> statement-breakpoint
ALTER TABLE "domain_problem_bindings" DROP COLUMN "required_version_id";