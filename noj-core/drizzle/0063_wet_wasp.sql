CREATE TABLE "content_review_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"target_id" text NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"review_provider" text NOT NULL,
	"verdict" text NOT NULL,
	"label" text,
	"hit_words" text,
	"risk_level" text,
	"content_snapshot" text DEFAULT '' NOT NULL,
	"meta" text DEFAULT '{}' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" text,
	"resolution" text,
	"action_taken" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "content_review_queue_content_type_check" CHECK ("content_review_queue"."content_type" IN ('post', 'comment', 'message')),
	CONSTRAINT "content_review_queue_channel_check" CHECK ("content_review_queue"."channel" IN ('ugc', 'dm')),
	CONSTRAINT "content_review_queue_status_check" CHECK ("content_review_queue"."status" IN ('pending_review', 'approved', 'rejected', 'reviewed', 'dismissed')),
	CONSTRAINT "content_review_queue_verdict_check" CHECK ("content_review_queue"."verdict" IN ('pass', 'review', 'block', 'error'))
);
--> statement-breakpoint
ALTER TABLE "content_review_queue" ADD CONSTRAINT "content_review_queue_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_content_review_queue_pending_status" ON "content_review_queue" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_content_review_queue_type_status" ON "content_review_queue" USING btree ("content_type","status");--> statement-breakpoint
CREATE INDEX "idx_content_review_queue_target" ON "content_review_queue" USING btree ("target_id");