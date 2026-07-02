CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"user1_id" text NOT NULL,
	"user2_id" text NOT NULL,
	"last_message_at" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "conversations_user_pair_unique" UNIQUE("user1_id","user2_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"content" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_reads" (
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"last_read_message_id" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "conversation_reads_user_id_conversation_id_pk" PRIMARY KEY("user_id","conversation_id")
);
--> statement-breakpoint
CREATE TABLE "message_deletions" (
	"user_id" text NOT NULL,
	"message_id" text NOT NULL,
	"deleted_at" text NOT NULL,
	CONSTRAINT "message_deletions_user_id_message_id_pk" PRIMARY KEY("user_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user1_id_users_id_fk" FOREIGN KEY ("user1_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user2_id_users_id_fk" FOREIGN KEY ("user2_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_deletions" ADD CONSTRAINT "message_deletions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_deletions" ADD CONSTRAINT "message_deletions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_conversations_user1_id" ON "conversations" USING btree ("user1_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_user2_id" ON "conversations" USING btree ("user2_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_last_message_at" ON "conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "idx_message_deletions_message_id" ON "message_deletions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_messages_conversation_created" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_messages_sender_id" ON "messages" USING btree ("sender_id");
