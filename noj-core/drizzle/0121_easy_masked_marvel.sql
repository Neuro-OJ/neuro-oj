CREATE TABLE "assignment_item_history" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"item_id" text NOT NULL,
	"problem_id" text NOT NULL,
	"answer_version_id" text,
	"policy_mode" text NOT NULL,
	"required_version_id" text,
	"policy_revision" integer NOT NULL,
	"reason" text NOT NULL,
	"actor_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "assignment_item_history_policy_check" CHECK (("assignment_item_history"."policy_mode" = 'any' AND "assignment_item_history"."required_version_id" IS NULL) OR
      ("assignment_item_history"."policy_mode" = 'exact' AND "assignment_item_history"."required_version_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "assignment_items" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"problem_id" text NOT NULL,
	"binding_id" text NOT NULL,
	"sort_order" integer NOT NULL,
	"requirement" text NOT NULL,
	"minimum_score" integer,
	"published_version_id" text,
	"published_policy_mode" text DEFAULT 'any' NOT NULL,
	"published_required_version_id" text,
	"published_policy_revision" integer DEFAULT 0 NOT NULL,
	"answer_version_id" text,
	"policy_revision" integer DEFAULT 0 NOT NULL,
	"resource_available" boolean DEFAULT true NOT NULL,
	CONSTRAINT "assignment_items_domain_id_unique" UNIQUE("domain_id","id"),
	CONSTRAINT "assignment_items_id_problem_unique" UNIQUE("id","problem_id"),
	CONSTRAINT "assignment_items_assignment_id_unique" UNIQUE("domain_id","assignment_id","id"),
	CONSTRAINT "assignment_items_problem_unique" UNIQUE("assignment_id","problem_id"),
	CONSTRAINT "assignment_items_order_unique" UNIQUE("assignment_id","sort_order"),
	CONSTRAINT "assignment_items_requirement_check" CHECK (("assignment_items"."requirement" = 'accepted' AND "assignment_items"."minimum_score" IS NULL) OR
    ("assignment_items"."requirement" = 'min_score' AND "assignment_items"."minimum_score" IS NOT NULL AND "assignment_items"."minimum_score" BETWEEN 0 AND 10000)),
	CONSTRAINT "assignment_items_published_policy_check" CHECK (("assignment_items"."published_policy_mode" = 'any' AND "assignment_items"."published_required_version_id" IS NULL) OR
    ("assignment_items"."published_policy_mode" = 'exact' AND "assignment_items"."published_required_version_id" IS NOT NULL)),
	CONSTRAINT "assignment_items_order_check" CHECK ("assignment_items"."sort_order" >= 0 AND "assignment_items"."policy_revision" >= 0 AND "assignment_items"."published_policy_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "assignment_progress" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"item_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"status" text NOT NULL,
	"score" integer,
	"accepted" boolean DEFAULT false NOT NULL,
	"source_submission_id" text,
	"source_kind" text,
	"source_attempt_id" text,
	"evaluated_version_id" text,
	"accepted_attempt_id" text,
	"policy_revision" integer DEFAULT 0 NOT NULL,
	"projection_revision" bigint DEFAULT 0 NOT NULL,
	"late" boolean DEFAULT false NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "assignment_progress_cell_unique" UNIQUE("item_id","user_id","scope"),
	CONSTRAINT "assignment_progress_scope_check" CHECK ("assignment_progress"."scope" IN ('on_time', 'current')),
	CONSTRAINT "assignment_progress_status_check" CHECK ("assignment_progress"."status" IN ('not_started', 'judging', 'below_target', 'achieved', 'unavailable')),
	CONSTRAINT "assignment_progress_score_check" CHECK ("assignment_progress"."score" IS NULL OR "assignment_progress"."score" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "assignment_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"classroom_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"added_by" text NOT NULL,
	"joined_at" text NOT NULL,
	"left_at" text,
	"credit_intervals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "assignment_recipients_user_unique" UNIQUE("assignment_id","user_id"),
	CONSTRAINT "assignment_recipients_status_check" CHECK ("assignment_recipients"."status" IN ('active', 'historical')),
	CONSTRAINT "assignment_recipients_added_by_check" CHECK ("assignment_recipients"."added_by" IN ('initial', 'automatic', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"classroom_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"publish_at" text,
	"deadline_at" text,
	"published_at" text,
	"ended_at" text,
	"archived_at" text,
	"include_previous_submissions" boolean DEFAULT false NOT NULL,
	"target_student_ids" jsonb,
	"source_assignment_id" text,
	"source_contest_id" text,
	"publish_error" text,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "assignments_domain_id_unique" UNIQUE("domain_id","id"),
	CONSTRAINT "assignments_class_domain_unique" UNIQUE("domain_id","id","classroom_id"),
	CONSTRAINT "assignments_state_check" CHECK ("assignments"."state" IN ('draft', 'scheduled', 'published', 'archived')),
	CONSTRAINT "assignments_revision_check" CHECK ("assignments"."revision" >= 0),
	CONSTRAINT "assignments_schedule_check" CHECK ("assignments"."state" <> 'scheduled' OR "assignments"."publish_at" IS NOT NULL),
	CONSTRAINT "assignments_publish_check" CHECK ("assignments"."state" <> 'published' OR "assignments"."published_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "education_disabled_intervals" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"started_at" text NOT NULL,
	"ended_at" text,
	"reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "education_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "education_operations_key_unique" UNIQUE("domain_id","actor_id","operation","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "education_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"event_type" text NOT NULL,
	"user_id" text,
	"problem_id" text,
	"classroom_id" text,
	"assignment_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" text NOT NULL,
	"available_at" text NOT NULL,
	"leased_until" text,
	"lease_token" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processed_at" text,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "assignment_item_history" ADD CONSTRAINT "assignment_item_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_item_history" ADD CONSTRAINT "assignment_item_history_item_domain_fk" FOREIGN KEY ("domain_id","item_id") REFERENCES "assignment_items"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_item_history" ADD CONSTRAINT "assignment_item_history_item_problem_fk" FOREIGN KEY ("item_id","problem_id") REFERENCES "assignment_items"("id","problem_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_item_history" ADD CONSTRAINT "assignment_item_history_answer_version_fk" FOREIGN KEY ("problem_id","answer_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_item_history" ADD CONSTRAINT "assignment_item_history_required_version_fk" FOREIGN KEY ("problem_id","required_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_items" ADD CONSTRAINT "assignment_items_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_items" ADD CONSTRAINT "assignment_items_assignment_domain_fk" FOREIGN KEY ("domain_id","assignment_id") REFERENCES "assignments"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_items" ADD CONSTRAINT "assignment_items_binding_domain_fk" FOREIGN KEY ("domain_id","binding_id") REFERENCES "domain_problem_bindings"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_items" ADD CONSTRAINT "assignment_items_binding_problem_fk" FOREIGN KEY ("binding_id","problem_id") REFERENCES "domain_problem_bindings"("id","problem_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_items" ADD CONSTRAINT "assignment_items_published_version_fk" FOREIGN KEY ("problem_id","published_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_items" ADD CONSTRAINT "assignment_items_required_version_fk" FOREIGN KEY ("problem_id","published_required_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_items" ADD CONSTRAINT "assignment_items_answer_version_fk" FOREIGN KEY ("problem_id","answer_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_progress" ADD CONSTRAINT "assignment_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_progress" ADD CONSTRAINT "assignment_progress_source_attempt_id_evaluation_attempts_id_fk" FOREIGN KEY ("source_attempt_id") REFERENCES "evaluation_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_progress" ADD CONSTRAINT "assignment_progress_evaluated_version_id_problem_versions_id_fk" FOREIGN KEY ("evaluated_version_id") REFERENCES "problem_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_progress" ADD CONSTRAINT "assignment_progress_accepted_attempt_id_evaluation_attempts_id_fk" FOREIGN KEY ("accepted_attempt_id") REFERENCES "evaluation_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_progress" ADD CONSTRAINT "assignment_progress_item_assignment_fk" FOREIGN KEY ("domain_id","assignment_id","item_id") REFERENCES "assignment_items"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_progress" ADD CONSTRAINT "assignment_progress_recipient_fk" FOREIGN KEY ("assignment_id","user_id") REFERENCES "assignment_recipients"("assignment_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_recipients" ADD CONSTRAINT "assignment_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_recipients" ADD CONSTRAINT "assignment_recipients_assignment_class_fk" FOREIGN KEY ("domain_id","assignment_id","classroom_id") REFERENCES "assignments"("domain_id","id","classroom_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_recipients" ADD CONSTRAINT "assignment_recipients_class_member_fk" FOREIGN KEY ("domain_id","classroom_id","user_id") REFERENCES "classroom_memberships"("domain_id","classroom_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_source_assignment_id_assignments_id_fk" FOREIGN KEY ("source_assignment_id") REFERENCES "assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_classroom_domain_fk" FOREIGN KEY ("domain_id","classroom_id") REFERENCES "classrooms"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_source_contest_domain_fk" FOREIGN KEY ("domain_id","source_contest_id") REFERENCES "contests"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_source_assignment_domain_fk" FOREIGN KEY ("domain_id","source_assignment_id") REFERENCES "assignments"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education_disabled_intervals" ADD CONSTRAINT "education_disabled_intervals_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education_operations" ADD CONSTRAINT "education_operations_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education_operations" ADD CONSTRAINT "education_operations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education_outbox" ADD CONSTRAINT "education_outbox_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education_outbox" ADD CONSTRAINT "education_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education_outbox" ADD CONSTRAINT "education_outbox_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education_outbox" ADD CONSTRAINT "education_outbox_classroom_domain_fk" FOREIGN KEY ("domain_id","classroom_id") REFERENCES "classrooms"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education_outbox" ADD CONSTRAINT "education_outbox_assignment_domain_fk" FOREIGN KEY ("domain_id","assignment_id") REFERENCES "assignments"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_assignment_items_binding" ON "assignment_items" USING btree ("domain_id","binding_id","assignment_id");--> statement-breakpoint
CREATE INDEX "idx_assignment_progress_matrix" ON "assignment_progress" USING btree ("domain_id","assignment_id","user_id","scope");--> statement-breakpoint
CREATE INDEX "idx_assignment_recipients_domain_user" ON "assignment_recipients" USING btree ("domain_id","user_id","assignment_id");--> statement-breakpoint
CREATE INDEX "idx_assignments_class_state" ON "assignments" USING btree ("domain_id","classroom_id","state","deadline_at");--> statement-breakpoint
CREATE INDEX "idx_education_disabled_intervals_domain" ON "education_disabled_intervals" USING btree ("domain_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_education_outbox_pending" ON "education_outbox" USING btree ("processed_at","available_at","leased_until");
