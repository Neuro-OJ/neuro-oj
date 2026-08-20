CREATE TABLE "training_problems" (
	"training_id" text NOT NULL,
	"problem_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "training_problems_training_id_problem_id_pk" PRIMARY KEY("training_id","problem_id"),
	CONSTRAINT "training_problems_training_position_unique" UNIQUE("training_id","position")
);
--> statement-breakpoint
CREATE TABLE "trainings" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "trainings_visibility_check" CHECK ("trainings"."visibility" IN ('private', 'unlisted', 'public'))
);
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_action_check";--> statement-breakpoint
ALTER TABLE "tags" DROP CONSTRAINT "tags_kind_check";--> statement-breakpoint
ALTER TABLE "training_problems" ADD CONSTRAINT "training_problems_training_id_trainings_id_fk" FOREIGN KEY ("training_id") REFERENCES "trainings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_problems" ADD CONSTRAINT "training_problems_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trainings" ADD CONSTRAINT "trainings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_training_problems_training_position" ON "training_problems" USING btree ("training_id","position");--> statement-breakpoint
CREATE INDEX "idx_trainings_visibility_pinned_created" ON "trainings" USING btree ("visibility","is_pinned","created_at");--> statement-breakpoint
CREATE INDEX "idx_trainings_created_by" ON "trainings" USING btree ("created_by");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_check" CHECK ("audit_logs"."action" IN (
        'users.role_change',
        'users.ban',
        'users.unban',
        'problems.delete',
        'problems.runtime_config_changed',
        'problems.imported',
        'tags.create',
        'tags.update',
        'tags.delete',
        'tags.merge',
        'submissions.rejudge',
        'settings.update',
        'ip_ban.create',
        'ip_ban.delete',
        'auth.login_success',
        'auth.login_failure',
        'auth.register',
        'auth.change_password',
        'auth.forgot_password_request',
        'auth.password_reset',
        'community.post_moderated',
        'community.report_resolved',
        'community.sanction_created',
        'community.sanction_revoked',
        'community.preset_applied',
        'announcement.create',
        'announcement.update',
        'announcement.delete'
      ));--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_kind_check" CHECK ("tags"."kind" IN ('problem', 'algorithm'));