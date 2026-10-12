ALTER TABLE "assignment_recipients" ADD CONSTRAINT "assignment_recipients_target_unique" UNIQUE("domain_id","assignment_id","user_id");--> statement-breakpoint
CREATE TABLE "assignment_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"target_user_id" text,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	CONSTRAINT "assignment_feedback_scope_unique" UNIQUE("domain_id","assignment_id","id"),
	CONSTRAINT "assignment_feedback_revision_check" CHECK ("assignment_feedback"."revision" >= 0),
	CONSTRAINT "assignment_feedback_body_check" CHECK (char_length("assignment_feedback"."body") BETWEEN 1 AND 30000)
);--> statement-breakpoint
CREATE TABLE "assignment_help_replies" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"help_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "assignment_help_replies_scope_unique" UNIQUE("domain_id","assignment_id","id"),
	CONSTRAINT "assignment_help_replies_body_check" CHECK (char_length("assignment_help_replies"."body") BETWEEN 1 AND 30000)
);--> statement-breakpoint
CREATE TABLE "assignment_help_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"item_id" text,
	"submission_id" text,
	"objective_submission_id" text,
	"body" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"handled_by" text,
	"handled_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "assignment_help_requests_scope_unique" UNIQUE("domain_id","assignment_id","id"),
	CONSTRAINT "assignment_help_requests_source_check" CHECK (NOT ("assignment_help_requests"."submission_id" IS NOT NULL AND "assignment_help_requests"."objective_submission_id" IS NOT NULL)),
	CONSTRAINT "assignment_help_requests_state_check" CHECK ("assignment_help_requests"."state" IN ('open','resolved')),
	CONSTRAINT "assignment_help_requests_revision_check" CHECK ("assignment_help_requests"."revision" >= 0),
	CONSTRAINT "assignment_help_requests_body_check" CHECK (char_length("assignment_help_requests"."body") BETWEEN 1 AND 30000)
);--> statement-breakpoint
CREATE TABLE "education_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"feedback_id" text,
	"help_id" text,
	"reply_id" text,
	"created_at" text NOT NULL,
	"read_at" text,
	CONSTRAINT "education_notifications_delivery_unique" UNIQUE("event_id","user_id"),
	CONSTRAINT "education_notifications_type_check" CHECK ("education_notifications"."type" IN ('assignment','assignment_changed','resource_unavailable','feedback','help','help_reply')),
	CONSTRAINT "education_notifications_source_check" CHECK (
    ("education_notifications"."type" IN ('assignment','assignment_changed','resource_unavailable') AND "education_notifications"."feedback_id" IS NULL AND "education_notifications"."help_id" IS NULL AND "education_notifications"."reply_id" IS NULL)
    OR ("education_notifications"."type" = 'feedback' AND "education_notifications"."feedback_id" IS NOT NULL AND "education_notifications"."help_id" IS NULL AND "education_notifications"."reply_id" IS NULL)
    OR ("education_notifications"."type" = 'help' AND "education_notifications"."feedback_id" IS NULL AND "education_notifications"."help_id" IS NOT NULL AND "education_notifications"."reply_id" IS NULL)
    OR ("education_notifications"."type" = 'help_reply' AND "education_notifications"."feedback_id" IS NULL AND "education_notifications"."help_id" IS NOT NULL AND "education_notifications"."reply_id" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "assignment_feedback" ADD CONSTRAINT "assignment_feedback_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_feedback" ADD CONSTRAINT "assignment_feedback_assignment_fk" FOREIGN KEY ("domain_id","assignment_id") REFERENCES "assignments"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_feedback" ADD CONSTRAINT "assignment_feedback_recipient_fk" FOREIGN KEY ("domain_id","assignment_id","target_user_id") REFERENCES "assignment_recipients"("domain_id","assignment_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_help_replies" ADD CONSTRAINT "assignment_help_replies_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_help_replies" ADD CONSTRAINT "assignment_help_replies_request_fk" FOREIGN KEY ("domain_id","assignment_id","help_id") REFERENCES "assignment_help_requests"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_help_requests" ADD CONSTRAINT "assignment_help_requests_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_help_requests" ADD CONSTRAINT "assignment_help_requests_objective_submission_id_objective_submissions_id_fk" FOREIGN KEY ("objective_submission_id") REFERENCES "objective_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_help_requests" ADD CONSTRAINT "assignment_help_requests_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_help_requests" ADD CONSTRAINT "assignment_help_requests_recipient_fk" FOREIGN KEY ("domain_id","assignment_id","user_id") REFERENCES "assignment_recipients"("domain_id","assignment_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_help_requests" ADD CONSTRAINT "assignment_help_requests_item_fk" FOREIGN KEY ("domain_id","assignment_id","item_id") REFERENCES "assignment_items"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education_notifications" ADD CONSTRAINT "education_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education_notifications" ADD CONSTRAINT "education_notifications_event_id_education_outbox_id_fk" FOREIGN KEY ("event_id") REFERENCES "education_outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education_notifications" ADD CONSTRAINT "education_notifications_assignment_fk" FOREIGN KEY ("domain_id","assignment_id") REFERENCES "assignments"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education_notifications" ADD CONSTRAINT "education_notifications_feedback_fk" FOREIGN KEY ("domain_id","assignment_id","feedback_id") REFERENCES "assignment_feedback"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education_notifications" ADD CONSTRAINT "education_notifications_help_fk" FOREIGN KEY ("domain_id","assignment_id","help_id") REFERENCES "assignment_help_requests"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education_notifications" ADD CONSTRAINT "education_notifications_reply_fk" FOREIGN KEY ("domain_id","assignment_id","reply_id") REFERENCES "assignment_help_replies"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_assignment_feedback_list" ON "assignment_feedback" USING btree ("domain_id","assignment_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_assignment_help_replies_list" ON "assignment_help_replies" USING btree ("help_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_assignment_help_requests_list" ON "assignment_help_requests" USING btree ("domain_id","assignment_id","state","created_at");--> statement-breakpoint
CREATE INDEX "idx_education_notifications_user" ON "education_notifications" USING btree ("domain_id","user_id","created_at");
