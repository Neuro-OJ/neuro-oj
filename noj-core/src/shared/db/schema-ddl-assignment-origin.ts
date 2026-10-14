/** 作业来源约束在教学表建立后添加，历史记录保留空来源。 */
export const ASSIGNMENT_ORIGIN_DDL = [
  'ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_assignment_origin_fk" FOREIGN KEY ("domain_id","assignment_id","assignment_item_id") REFERENCES "assignment_items"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_assignment_problem_fk" FOREIGN KEY ("assignment_item_id","paper_id") REFERENCES "assignment_items"("id","problem_id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_assignment_domain_fk" FOREIGN KEY ("domain_id","assignment_id") REFERENCES "assignments"("domain_id","id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "self_tests" ADD CONSTRAINT "self_tests_assignment_origin_fk" FOREIGN KEY ("domain_id","assignment_id","assignment_item_id") REFERENCES "assignment_items"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "self_tests" ADD CONSTRAINT "self_tests_assignment_problem_fk" FOREIGN KEY ("assignment_item_id","problem_id") REFERENCES "assignment_items"("id","problem_id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "self_tests" ADD CONSTRAINT "self_tests_assignment_domain_fk" FOREIGN KEY ("domain_id","assignment_id") REFERENCES "assignments"("domain_id","id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "submissions" ADD CONSTRAINT "submissions_assignment_origin_fk" FOREIGN KEY ("domain_id","assignment_id","assignment_item_id") REFERENCES "assignment_items"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "submissions" ADD CONSTRAINT "submissions_assignment_problem_fk" FOREIGN KEY ("assignment_item_id","problem_id") REFERENCES "assignment_items"("id","problem_id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "submissions" ADD CONSTRAINT "submissions_assignment_domain_fk" FOREIGN KEY ("domain_id","assignment_id") REFERENCES "assignments"("domain_id","id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_assignment_origin_check" CHECK (("objective_submissions"."assignment_id" IS NULL) = ("objective_submissions"."assignment_item_id" IS NULL));',
  'ALTER TABLE "self_tests" ADD CONSTRAINT "self_tests_assignment_origin_check" CHECK (("self_tests"."assignment_id" IS NULL) = ("self_tests"."assignment_item_id" IS NULL));',
  'ALTER TABLE "submissions" ADD CONSTRAINT "submissions_assignment_origin_check" CHECK (("submissions"."assignment_id" IS NULL) = ("submissions"."assignment_item_id" IS NULL));',
];
