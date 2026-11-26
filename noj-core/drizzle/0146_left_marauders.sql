CREATE TABLE "user_knowledge_placements" (
	"user_id" text NOT NULL,
	"node_id" text NOT NULL,
	"source" text DEFAULT 'self_assessed' NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "user_knowledge_placements_user_id_node_id_pk" PRIMARY KEY("user_id","node_id"),
	CONSTRAINT "user_knowledge_placements_source_check" CHECK ("user_knowledge_placements"."source" IN ('self_assessed', 'diagnostic_passed'))
);
--> statement-breakpoint
ALTER TABLE "user_knowledge_placements" ADD CONSTRAINT "user_knowledge_placements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_knowledge_placements" ADD CONSTRAINT "user_knowledge_placements_node_id_knowledge_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."knowledge_nodes"("id") ON DELETE cascade ON UPDATE no action;