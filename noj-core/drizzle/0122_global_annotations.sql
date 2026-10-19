CREATE TABLE "annotation_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"withdrawn_at" text,
	CONSTRAINT "annotation_messages_revision_check" CHECK ("annotation_messages"."revision" >= 0 AND length("annotation_messages"."body") BETWEEN 1 AND 30000)
);
--> statement-breakpoint
CREATE TABLE "annotation_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" text NOT NULL,
	"read_at" text,
	CONSTRAINT "annotation_notifications_message_user_unique" UNIQUE("message_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "annotation_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"resource_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "annotation_operations_identity_unique" UNIQUE("domain_id","actor_id","operation","key")
);
--> statement-breakpoint
CREATE TABLE "annotation_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"target" jsonb NOT NULL,
	"target_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"content" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "annotation_sources_domain_identity_unique" UNIQUE("domain_id","id"),
	CONSTRAINT "annotation_sources_version_unique" UNIQUE("domain_id","target_key","content_hash"),
	CONSTRAINT "annotation_sources_hash_check" CHECK ("annotation_sources"."content_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "annotation_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"source_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"student_id" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"anchor" jsonb NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"withdrawn_at" text,
	CONSTRAINT "annotation_threads_domain_identity_unique" UNIQUE("domain_id","id"),
	CONSTRAINT "annotation_threads_audience_check" CHECK (("annotation_threads"."visibility" = 'private' AND "annotation_threads"."student_id" IS NULL) OR ("annotation_threads"."visibility" = 'teaching' AND "annotation_threads"."student_id" IS NOT NULL)),
	CONSTRAINT "annotation_threads_state_check" CHECK ("annotation_threads"."state" IN ('open','resolved') AND "annotation_threads"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "annotation_messages" ADD CONSTRAINT "annotation_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_messages" ADD CONSTRAINT "annotation_messages_thread_domain_fk" FOREIGN KEY ("domain_id","thread_id") REFERENCES "public"."annotation_threads"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_notifications" ADD CONSTRAINT "annotation_notifications_message_id_annotation_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."annotation_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_notifications" ADD CONSTRAINT "annotation_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_notifications" ADD CONSTRAINT "annotation_notifications_thread_domain_fk" FOREIGN KEY ("domain_id","thread_id") REFERENCES "public"."annotation_threads"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_operations" ADD CONSTRAINT "annotation_operations_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_operations" ADD CONSTRAINT "annotation_operations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_sources" ADD CONSTRAINT "annotation_sources_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_threads" ADD CONSTRAINT "annotation_threads_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_threads" ADD CONSTRAINT "annotation_threads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_threads" ADD CONSTRAINT "annotation_threads_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_threads" ADD CONSTRAINT "annotation_threads_source_domain_fk" FOREIGN KEY ("domain_id","source_id") REFERENCES "public"."annotation_sources"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_annotation_messages_thread" ON "annotation_messages" USING btree ("thread_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_annotation_notifications_inbox" ON "annotation_notifications" USING btree ("domain_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_annotation_threads_owner" ON "annotation_threads" USING btree ("domain_id","owner_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_annotation_threads_student" ON "annotation_threads" USING btree ("domain_id","student_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_annotation_threads_source" ON "annotation_threads" USING btree ("domain_id","source_id");