CREATE TABLE "community_activity_events" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"type" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "community_activity_events_dedupe_unique" UNIQUE("actor_id","type","subject_type","subject_id"),
	CONSTRAINT "community_activity_events_type_check" CHECK ("community_activity_events"."type" IN ('first_accepted', 'solution_published', 'contest_joined'))
);
--> statement-breakpoint
CREATE TABLE "community_board_role_grants" (
	"board_id" text NOT NULL,
	"role_id" text NOT NULL,
	"can_read" boolean DEFAULT true NOT NULL,
	"can_post" boolean DEFAULT false NOT NULL,
	"can_moderate" boolean DEFAULT false NOT NULL,
	CONSTRAINT "community_board_role_grants_board_id_role_id_pk" PRIMARY KEY("board_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "community_boards" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "community_boards_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "community_bookmarks" (
	"post_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "community_bookmarks_post_id_user_id_pk" PRIMARY KEY("post_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "community_comment_likes" (
	"comment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "community_comment_likes_comment_id_user_id_pk" PRIMARY KEY("comment_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "community_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"author_id" text NOT NULL,
	"parent_id" text,
	"content" text NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"moderation_reason" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "community_comments_status_check" CHECK ("community_comments"."status" IN ('pending', 'published', 'hidden', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "community_follows" (
	"follower_id" text NOT NULL,
	"followee_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "community_follows_follower_id_followee_id_pk" PRIMARY KEY("follower_id","followee_id"),
	CONSTRAINT "community_follows_not_self_check" CHECK ("community_follows"."follower_id" <> "community_follows"."followee_id")
);
--> statement-breakpoint
CREATE TABLE "community_moderation_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"moderator_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient_id" text NOT NULL,
	"actor_id" text,
	"type" text NOT NULL,
	"post_id" text,
	"comment_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" text,
	"created_at" text NOT NULL,
	CONSTRAINT "community_notifications_type_check" CHECK ("community_notifications"."type" IN ('reply', 'like', 'follow', 'moderation'))
);
--> statement-breakpoint
CREATE TABLE "community_post_likes" (
	"post_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "community_post_likes_post_id_user_id_pk" PRIMARY KEY("post_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "community_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"author_id" text NOT NULL,
	"problem_id" text,
	"board_id" text,
	"title" text,
	"content" text NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"moderation_reason" text,
	"published_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "community_posts_type_check" CHECK ("community_posts"."type" IN ('solution', 'discussion', 'moment')),
	CONSTRAINT "community_posts_status_check" CHECK ("community_posts"."status" IN ('draft', 'pending', 'published', 'hidden', 'deleted')),
	CONSTRAINT "community_posts_context_check" CHECK ((
        ("community_posts"."type" = 'solution' AND "community_posts"."problem_id" IS NOT NULL AND "community_posts"."board_id" IS NULL AND "community_posts"."title" IS NOT NULL)
        OR ("community_posts"."type" = 'discussion' AND "community_posts"."board_id" IS NOT NULL AND "community_posts"."problem_id" IS NULL AND "community_posts"."title" IS NOT NULL)
        OR ("community_posts"."type" = 'moment' AND "community_posts"."problem_id" IS NULL AND "community_posts"."board_id" IS NULL AND "community_posts"."title" IS NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "community_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"reporter_id" text NOT NULL,
	"post_id" text,
	"comment_id" text,
	"reason" text NOT NULL,
	"content_snapshot" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolution" text,
	"resolved_by" text,
	"resolved_at" text,
	"created_at" text NOT NULL,
	CONSTRAINT "community_reports_target_check" CHECK (num_nonnulls("community_reports"."post_id", "community_reports"."comment_id") = 1),
	CONSTRAINT "community_reports_status_check" CHECK ("community_reports"."status" IN ('pending', 'resolved', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "community_sanctions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"reason" text NOT NULL,
	"expires_at" text,
	"created_by" text,
	"created_at" text NOT NULL,
	"revoked_at" text,
	"revoked_by" text
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "community_activity_visibility" text DEFAULT 'following' NOT NULL;--> statement-breakpoint
ALTER TABLE "community_activity_events" ADD CONSTRAINT "community_activity_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_board_role_grants" ADD CONSTRAINT "community_board_role_grants_board_id_community_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "community_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_board_role_grants" ADD CONSTRAINT "community_board_role_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_bookmarks" ADD CONSTRAINT "community_bookmarks_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_bookmarks" ADD CONSTRAINT "community_bookmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_comment_likes" ADD CONSTRAINT "community_comment_likes_comment_id_community_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "community_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_comment_likes" ADD CONSTRAINT "community_comment_likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_parent_id_community_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "community_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_follows" ADD CONSTRAINT "community_follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_follows" ADD CONSTRAINT "community_follows_followee_id_users_id_fk" FOREIGN KEY ("followee_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_moderation_actions" ADD CONSTRAINT "community_moderation_actions_moderator_id_users_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_notifications" ADD CONSTRAINT "community_notifications_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_notifications" ADD CONSTRAINT "community_notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_notifications" ADD CONSTRAINT "community_notifications_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_notifications" ADD CONSTRAINT "community_notifications_comment_id_community_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "community_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_post_likes" ADD CONSTRAINT "community_post_likes_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_post_likes" ADD CONSTRAINT "community_post_likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_board_id_community_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "community_boards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_comment_id_community_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "community_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_sanctions" ADD CONSTRAINT "community_sanctions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_sanctions" ADD CONSTRAINT "community_sanctions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_sanctions" ADD CONSTRAINT "community_sanctions_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_community_activity_events_actor" ON "community_activity_events" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_community_board_role_grants_role" ON "community_board_role_grants" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "idx_community_boards_sort" ON "community_boards" USING btree ("is_archived","sort_order");--> statement-breakpoint
CREATE INDEX "idx_community_bookmarks_user" ON "community_bookmarks" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_community_comment_likes_user" ON "community_comment_likes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_community_comments_post" ON "community_comments" USING btree ("post_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_community_comments_author" ON "community_comments" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "idx_community_comments_parent" ON "community_comments" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_community_follows_followee" ON "community_follows" USING btree ("followee_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_community_moderation_actions_target" ON "community_moderation_actions" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_community_moderation_actions_moderator" ON "community_moderation_actions" USING btree ("moderator_id");--> statement-breakpoint
CREATE INDEX "idx_community_notifications_recipient" ON "community_notifications" USING btree ("recipient_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_community_notifications_unread" ON "community_notifications" USING btree ("recipient_id","created_at") WHERE "community_notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_community_notifications_actor" ON "community_notifications" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_community_notifications_post" ON "community_notifications" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "idx_community_notifications_comment" ON "community_notifications" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "idx_community_post_likes_user" ON "community_post_likes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_community_posts_author" ON "community_posts" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_community_posts_problem" ON "community_posts" USING btree ("problem_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_community_posts_board" ON "community_posts" USING btree ("board_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_community_posts_published" ON "community_posts" USING btree ("type","is_pinned","created_at") WHERE "community_posts"."status" = 'published';--> statement-breakpoint
CREATE INDEX "idx_community_posts_pending" ON "community_posts" USING btree ("created_at") WHERE "community_posts"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_community_reports_pending" ON "community_reports" USING btree ("created_at") WHERE "community_reports"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_community_reports_reporter" ON "community_reports" USING btree ("reporter_id");--> statement-breakpoint
CREATE INDEX "idx_community_reports_post" ON "community_reports" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "idx_community_reports_comment" ON "community_reports" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "idx_community_sanctions_active" ON "community_sanctions" USING btree ("user_id") WHERE "community_sanctions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_community_sanctions_creator" ON "community_sanctions" USING btree ("created_by");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_community_activity_visibility_check" CHECK ("users"."community_activity_visibility" IN ('hidden', 'following', 'everyone'));