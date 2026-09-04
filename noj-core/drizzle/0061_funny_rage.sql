CREATE TABLE "message_reactions" (
	"message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "message_reactions_message_id_user_id_emoji_pk" PRIMARY KEY("message_id","user_id","emoji")
);
--> statement-breakpoint
ALTER TABLE "community_reports" DROP CONSTRAINT "community_reports_target_check";--> statement-breakpoint
ALTER TABLE "community_reports" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "type" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reply_to_message_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "forwarded_from_user_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "edited_at" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "recalled_at" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "edit_history" text;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_message_reactions_message_id" ON "message_reactions" USING btree ("message_id");--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_message_id_messages_id_fk" FOREIGN KEY ("reply_to_message_id") REFERENCES "messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_forwarded_from_user_id_users_id_fk" FOREIGN KEY ("forwarded_from_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_community_reports_message" ON "community_reports" USING btree ("message_id");--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_target_check" CHECK (num_nonnulls("community_reports"."post_id", "community_reports"."comment_id", "community_reports"."message_id") = 1);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_type_check" CHECK ("messages"."type" IN ('text', 'image'));