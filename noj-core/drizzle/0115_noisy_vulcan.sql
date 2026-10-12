CREATE TABLE "domain_problem_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"problem_id" text NOT NULL,
	"kind" text NOT NULL,
	"visibility" text DEFAULT 'members' NOT NULL,
	"effective_version_mode" text DEFAULT 'any' NOT NULL,
	"required_version_id" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"disabled_at" text,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "domain_problem_bindings_identity_unique" UNIQUE("domain_id","problem_id"),
	CONSTRAINT "domain_problem_bindings_domain_id_unique" UNIQUE("domain_id","id"),
	CONSTRAINT "domain_problem_bindings_id_problem_unique" UNIQUE("id","problem_id"),
	CONSTRAINT "domain_problem_bindings_kind_check" CHECK ("domain_problem_bindings"."kind" IN ('owned', 'shared')),
	CONSTRAINT "domain_problem_bindings_visibility_check" CHECK ("domain_problem_bindings"."visibility" IN ('public', 'members')),
	CONSTRAINT "domain_problem_bindings_policy_check" CHECK (("domain_problem_bindings"."effective_version_mode" = 'any' AND "domain_problem_bindings"."required_version_id" IS NULL) OR ("domain_problem_bindings"."effective_version_mode" = 'exact' AND "domain_problem_bindings"."required_version_id" IS NOT NULL)),
	CONSTRAINT "domain_problem_bindings_revision_check" CHECK ("domain_problem_bindings"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "domain_training_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"training_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"disabled_at" text,
	CONSTRAINT "domain_training_bindings_identity_unique" UNIQUE("domain_id","training_id")
);
--> statement-breakpoint
CREATE TABLE "problem_binding_history" (
	"id" text PRIMARY KEY NOT NULL,
	"binding_id" text NOT NULL,
	"problem_id" text NOT NULL,
	"revision" integer NOT NULL,
	"effective_version_mode" text NOT NULL,
	"required_version_id" text,
	"answer_version_id" text,
	"disabled_at" text,
	"actor_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "problem_binding_history_revision_unique" UNIQUE("binding_id","revision"),
	CONSTRAINT "problem_binding_history_policy_check" CHECK (("problem_binding_history"."effective_version_mode" = 'any' AND "problem_binding_history"."required_version_id" IS NULL) OR ("problem_binding_history"."effective_version_mode" = 'exact' AND "problem_binding_history"."required_version_id" IS NOT NULL)),
	CONSTRAINT "problem_binding_history_revision_check" CHECK ("problem_binding_history"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "problem_share_settings" (
	"problem_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"scope" text DEFAULT 'all' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "problem_share_settings_scope_check" CHECK ("problem_share_settings"."scope" IN ('all', 'selected')),
	CONSTRAINT "problem_share_settings_revision_check" CHECK ("problem_share_settings"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "problem_share_targets" (
	"problem_id" text NOT NULL,
	"domain_id" text NOT NULL,
	CONSTRAINT "problem_share_targets_problem_id_domain_id_pk" PRIMARY KEY("problem_id","domain_id")
);
--> statement-breakpoint
CREATE TABLE "training_share_settings" (
	"training_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"scope" text DEFAULT 'all' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "training_share_settings_scope_check" CHECK ("training_share_settings"."scope" IN ('all', 'selected')),
	CONSTRAINT "training_share_settings_revision_check" CHECK ("training_share_settings"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "training_share_targets" (
	"training_id" text NOT NULL,
	"domain_id" text NOT NULL,
	CONSTRAINT "training_share_targets_training_id_domain_id_pk" PRIMARY KEY("training_id","domain_id")
);
--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "trainings" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "domain_problem_bindings" ADD CONSTRAINT "domain_problem_bindings_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_problem_bindings" ADD CONSTRAINT "domain_problem_bindings_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_problem_bindings" ADD CONSTRAINT "domain_problem_bindings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_problem_bindings" ADD CONSTRAINT "domain_problem_bindings_required_version_fk" FOREIGN KEY ("problem_id","required_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_training_bindings" ADD CONSTRAINT "domain_training_bindings_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_training_bindings" ADD CONSTRAINT "domain_training_bindings_training_id_trainings_id_fk" FOREIGN KEY ("training_id") REFERENCES "trainings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_training_bindings" ADD CONSTRAINT "domain_training_bindings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_binding_history" ADD CONSTRAINT "problem_binding_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_binding_history" ADD CONSTRAINT "problem_binding_history_binding_fk" FOREIGN KEY ("binding_id","problem_id") REFERENCES "domain_problem_bindings"("id","problem_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_binding_history" ADD CONSTRAINT "problem_binding_history_required_version_fk" FOREIGN KEY ("problem_id","required_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_binding_history" ADD CONSTRAINT "problem_binding_history_answer_version_fk" FOREIGN KEY ("problem_id","answer_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_share_settings" ADD CONSTRAINT "problem_share_settings_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_share_settings" ADD CONSTRAINT "problem_share_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_share_targets" ADD CONSTRAINT "problem_share_targets_problem_id_problem_share_settings_problem_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problem_share_settings"("problem_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_share_targets" ADD CONSTRAINT "problem_share_targets_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_share_settings" ADD CONSTRAINT "training_share_settings_training_id_trainings_id_fk" FOREIGN KEY ("training_id") REFERENCES "trainings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_share_settings" ADD CONSTRAINT "training_share_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_share_targets" ADD CONSTRAINT "training_share_targets_training_id_training_share_settings_training_id_fk" FOREIGN KEY ("training_id") REFERENCES "training_share_settings"("training_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_share_targets" ADD CONSTRAINT "training_share_targets_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_domain_problem_bindings_source" ON "domain_problem_bindings" USING btree ("problem_id","domain_id");--> statement-breakpoint
CREATE INDEX "idx_domain_training_bindings_source" ON "domain_training_bindings" USING btree ("training_id");--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trainings" ADD CONSTRAINT "trainings_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_problems_domain_number" ON "problems" USING btree ("domain_id","number");--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_domain_id_id_unique" UNIQUE("domain_id","id");
