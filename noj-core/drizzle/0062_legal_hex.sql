CREATE TABLE "conversation_preferences" (
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"remark_name" text,
	"is_muted" boolean DEFAULT false NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "conversation_preferences_user_id_conversation_id_pk" PRIMARY KEY("user_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_preferences" ADD CONSTRAINT "conversation_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_preferences" ADD CONSTRAINT "conversation_preferences_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_conversation_preferences_conv" ON "conversation_preferences" USING btree ("conversation_id");