CREATE TABLE "user_knowledge_mastery" (
	"user_id" text NOT NULL,
	"node_id" text NOT NULL,
	"state" text DEFAULT 'none' NOT NULL,
	"solved_count" integer DEFAULT 0 NOT NULL,
	"attempted_count" integer DEFAULT 0 NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"max_passed_difficulty" integer,
	"updated_at" text NOT NULL,
	CONSTRAINT "user_knowledge_mastery_user_id_node_id_pk" PRIMARY KEY("user_id","node_id"),
	CONSTRAINT "user_knowledge_mastery_state_check" CHECK ("user_knowledge_mastery"."state" IN ('none', 'learning', 'mastered')),
	CONSTRAINT "user_knowledge_mastery_counts_check" CHECK ("user_knowledge_mastery"."solved_count" >= 0 AND "user_knowledge_mastery"."attempted_count" >= 0
        AND "user_knowledge_mastery"."failed_attempts" >= 0),
	CONSTRAINT "user_knowledge_mastery_max_difficulty_check" CHECK ("user_knowledge_mastery"."max_passed_difficulty" IS NULL
        OR ("user_knowledge_mastery"."max_passed_difficulty" >= 0
          AND "user_knowledge_mastery"."max_passed_difficulty" <= 100))
);
--> statement-breakpoint
ALTER TABLE "user_knowledge_mastery" ADD CONSTRAINT "user_knowledge_mastery_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_knowledge_mastery" ADD CONSTRAINT "user_knowledge_mastery_node_id_knowledge_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "knowledge_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_knowledge_mastery_node_state_idx" ON "user_knowledge_mastery" USING btree ("node_id","state");