-- 历史空域执行只可能来自原默认题库。发现非默认源题或任务冲突时中止，不能猜测使用域。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT problem_id FROM submissions WHERE domain_id IS NULL
      UNION ALL SELECT paper_id FROM objective_submissions WHERE domain_id IS NULL
      UNION ALL SELECT problem_id FROM self_tests WHERE domain_id IS NULL
    ) legacy JOIN problems p ON p.id = legacy.problem_id
    WHERE p.domain_id <> '00000000-0000-4000-8000-000000000001'
  ) OR EXISTS (
    SELECT 1 FROM submission_jobs j JOIN submission_job_items i ON i.job_id = j.id
    WHERE j.domain_id IS NULL AND i.domain_id IS NOT NULL
      AND i.domain_id <> '00000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION '执行归属需要核实：历史空域记录关联非默认域';
  END IF;
END $$;--> statement-breakpoint
UPDATE submissions SET domain_id = '00000000-0000-4000-8000-000000000001' WHERE domain_id IS NULL;--> statement-breakpoint
UPDATE objective_submissions SET domain_id = '00000000-0000-4000-8000-000000000001' WHERE domain_id IS NULL;--> statement-breakpoint
UPDATE self_tests SET domain_id = '00000000-0000-4000-8000-000000000001' WHERE domain_id IS NULL;--> statement-breakpoint
UPDATE submission_jobs SET domain_id = '00000000-0000-4000-8000-000000000001' WHERE domain_id IS NULL;--> statement-breakpoint
UPDATE submission_job_items item SET domain_id = job.domain_id
FROM submission_jobs job WHERE item.job_id = job.id AND item.domain_id IS NULL;--> statement-breakpoint
UPDATE submissions s SET domain_problem_binding_id = b.id
FROM domain_problem_bindings b WHERE s.domain_problem_binding_id IS NULL
  AND b.domain_id = s.domain_id AND b.problem_id = s.problem_id;--> statement-breakpoint
UPDATE objective_submissions s SET domain_problem_binding_id = b.id
FROM domain_problem_bindings b WHERE s.domain_problem_binding_id IS NULL
  AND b.domain_id = s.domain_id AND b.problem_id = s.paper_id;--> statement-breakpoint
UPDATE self_tests s SET domain_problem_binding_id = b.id
FROM domain_problem_bindings b WHERE s.domain_problem_binding_id IS NULL
  AND b.domain_id = s.domain_id AND b.problem_id = s.problem_id;--> statement-breakpoint
UPDATE submission_job_items item SET domain_problem_binding_id = b.id
FROM domain_problem_bindings b WHERE item.domain_problem_binding_id IS NULL
  AND b.domain_id = item.domain_id AND b.problem_id = item.problem_id;--> statement-breakpoint
DROP INDEX "submission_jobs_legacy_actor_kind_key_unique";--> statement-breakpoint
ALTER TABLE "objective_submissions" ALTER COLUMN "domain_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "objective_submissions" ALTER COLUMN "domain_problem_binding_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "self_tests" ALTER COLUMN "domain_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "self_tests" ALTER COLUMN "domain_problem_binding_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_job_items" ALTER COLUMN "domain_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_jobs" ALTER COLUMN "domain_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ALTER COLUMN "domain_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ALTER COLUMN "domain_problem_binding_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_job_items" ADD CONSTRAINT "submission_job_items_binding_required_check" CHECK ("submission_job_items"."domain_problem_binding_id" IS NOT NULL OR "submission_job_items"."status" IN ('failed', 'skipped'));
