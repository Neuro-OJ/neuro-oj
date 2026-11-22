CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text,
	"recipient_id" text NOT NULL,
	"actor_id" text,
	"type" text NOT NULL,
	"assignment_id" text,
	"event_id" text,
	"feedback_id" text,
	"help_id" text,
	"reply_id" text,
	"post_id" text,
	"comment_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" text,
	"created_at" text NOT NULL,
	CONSTRAINT "notifications_delivery_unique" UNIQUE("event_id","recipient_id"),
	CONSTRAINT "notifications_teaching_source_check" CHECK (
      ("notifications"."assignment_id" IS NULL AND "notifications"."event_id" IS NULL AND "notifications"."feedback_id" IS NULL AND "notifications"."help_id" IS NULL AND "notifications"."reply_id" IS NULL)
      OR ("notifications"."assignment_id" IS NOT NULL AND "notifications"."event_id" IS NOT NULL AND (
        ("notifications"."type" IN ('assignment','assignment_changed','resource_unavailable') AND "notifications"."feedback_id" IS NULL AND "notifications"."help_id" IS NULL AND "notifications"."reply_id" IS NULL)
        OR ("notifications"."type" = 'feedback' AND "notifications"."feedback_id" IS NOT NULL AND "notifications"."help_id" IS NULL AND "notifications"."reply_id" IS NULL)
        OR ("notifications"."type" = 'help' AND "notifications"."feedback_id" IS NULL AND "notifications"."help_id" IS NOT NULL AND "notifications"."reply_id" IS NULL)
        OR ("notifications"."type" = 'help_reply' AND "notifications"."feedback_id" IS NULL AND "notifications"."help_id" IS NOT NULL AND "notifications"."reply_id" IS NOT NULL)))),
	CONSTRAINT "community_notifications_workspace_check" CHECK (("notifications"."type" IN ('reply', 'like', 'moderation', 'clarification') AND "notifications"."domain_id" IS NOT NULL)
        OR ("notifications"."type" IN ('follow', 'ban') AND "notifications"."domain_id" IS NULL)
        OR "notifications"."type" = 'report'
        OR ("notifications"."type" IN ('assignment','assignment_changed','resource_unavailable','feedback','help','help_reply') AND "notifications"."domain_id" IS NOT NULL AND "notifications"."assignment_id" IS NOT NULL AND "notifications"."event_id" IS NOT NULL)),
	CONSTRAINT "community_notifications_type_check" CHECK ("notifications"."type" IN ('reply', 'like', 'follow', 'moderation', 'clarification', 'report', 'ban', 'assignment','assignment_changed','resource_unavailable','feedback','help','help_reply'))
);
--> statement-breakpoint
ALTER TABLE "community_notifications" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "education_notifications" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "education_notification_emails" DROP CONSTRAINT "education_notification_emails_notification_id_education_notifications_id_fk";
--> statement-breakpoint
INSERT INTO "notifications" ("id", "domain_id", "recipient_id", "actor_id", "type", "post_id", "comment_id", "data", "read_at", "created_at")
SELECT "id", "domain_id", "recipient_id", "actor_id", "type", "post_id", "comment_id", "data", "read_at", "created_at"
FROM "community_notifications" ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "notifications" ("id", "domain_id", "recipient_id", "type", "assignment_id", "event_id", "feedback_id", "help_id", "reply_id", "data", "read_at", "created_at")
SELECT "id", "domain_id", "user_id", "type", "assignment_id", "event_id", "feedback_id", "help_id", "reply_id", '{}'::jsonb, "read_at", "created_at"
FROM "education_notifications" ON CONFLICT DO NOTHING;--> statement-breakpoint
DELETE FROM "education_notification_emails" WHERE NOT EXISTS (SELECT 1 FROM "notifications" WHERE "notifications"."id" = "education_notification_emails"."notification_id");--> statement-breakpoint
DROP TABLE "community_notifications" CASCADE;--> statement-breakpoint
DROP TABLE "education_notifications" CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_education_outbox_id_fk" FOREIGN KEY ("event_id") REFERENCES "education_outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_comment_id_community_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "community_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_assignment_fk" FOREIGN KEY ("domain_id","assignment_id") REFERENCES "assignments"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_feedback_fk" FOREIGN KEY ("domain_id","assignment_id","feedback_id") REFERENCES "assignment_feedback"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_help_fk" FOREIGN KEY ("domain_id","assignment_id","help_id") REFERENCES "assignment_help_requests"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_reply_fk" FOREIGN KEY ("domain_id","assignment_id","reply_id") REFERENCES "assignment_help_replies"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "community_notifications_workspace_post_fk" FOREIGN KEY ("post_id","domain_id") REFERENCES "community_posts"("id","domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "community_notifications_workspace_comment_fk" FOREIGN KEY ("comment_id","domain_id") REFERENCES "community_comments"("id","domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_community_notifications_recipient" ON "notifications" USING btree ("recipient_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_community_notifications_unread" ON "notifications" USING btree ("recipient_id","created_at") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_community_notifications_actor" ON "notifications" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_community_notifications_post" ON "notifications" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "idx_community_notifications_comment" ON "notifications" USING btree ("comment_id");--> statement-breakpoint
ALTER TABLE "education_notification_emails" ADD CONSTRAINT "education_notification_emails_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE no action ON UPDATE no action;
