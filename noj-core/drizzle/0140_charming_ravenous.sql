CREATE TABLE "knowledge_tag_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"problem_id" text NOT NULL,
	"version_id" text,
	"content_hash" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"raw_output" jsonb,
	"created_at" text NOT NULL,
	CONSTRAINT "knowledge_tag_runs_status_check" CHECK ("knowledge_tag_runs"."status" IN ('succeeded', 'failed', 'skipped', 'budget_paused'))
);
--> statement-breakpoint
CREATE TABLE "problem_knowledge" (
	"problem_id" text NOT NULL,
	"node_id" text NOT NULL,
	"role" text NOT NULL,
	"source" text NOT NULL,
	"confidence" integer,
	"version_id" text,
	"review_status" text NOT NULL,
	"updated_by" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "problem_knowledge_problem_id_node_id_pk" PRIMARY KEY("problem_id","node_id"),
	CONSTRAINT "problem_knowledge_role_check" CHECK ("problem_knowledge"."role" IN ('primary', 'secondary')),
	CONSTRAINT "problem_knowledge_source_check" CHECK ("problem_knowledge"."source" IN ('ai', 'human')),
	CONSTRAINT "problem_knowledge_review_status_check" CHECK ("problem_knowledge"."review_status" IN ('auto', 'pending', 'confirmed', 'rejected')),
	CONSTRAINT "problem_knowledge_confidence_check" CHECK ("problem_knowledge"."confidence" IS NULL OR ("problem_knowledge"."confidence" >= 0 AND "problem_knowledge"."confidence" <= 100))
);
--> statement-breakpoint
ALTER TABLE "knowledge_tag_runs" ADD CONSTRAINT "knowledge_tag_runs_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_tag_runs" ADD CONSTRAINT "knowledge_tag_runs_version_id_problem_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "problem_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_knowledge" ADD CONSTRAINT "problem_knowledge_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_knowledge" ADD CONSTRAINT "problem_knowledge_node_id_knowledge_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "knowledge_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_knowledge" ADD CONSTRAINT "problem_knowledge_version_id_problem_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "problem_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_knowledge" ADD CONSTRAINT "problem_knowledge_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_tag_runs_problem_created_idx" ON "knowledge_tag_runs" USING btree ("problem_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "problem_knowledge_primary_uidx" ON "problem_knowledge" USING btree ("problem_id") WHERE "problem_knowledge"."role" = 'primary' AND "problem_knowledge"."review_status" <> 'rejected';--> statement-breakpoint
CREATE INDEX "problem_knowledge_node_idx" ON "problem_knowledge" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "problem_knowledge_review_status_idx" ON "problem_knowledge" USING btree ("review_status");