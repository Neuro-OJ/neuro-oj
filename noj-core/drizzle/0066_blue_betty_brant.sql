CREATE TABLE "contest_ranking_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"contest_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"rows" jsonb NOT NULL,
	"created_by" text,
	"created_at" text NOT NULL,
	CONSTRAINT "contest_ranking_snapshots_contest_version_unique" UNIQUE("contest_id","version")
);
--> statement-breakpoint
ALTER TABLE "contest_ranking_snapshots" ADD CONSTRAINT "contest_ranking_snapshots_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_ranking_snapshots" ADD CONSTRAINT "contest_ranking_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_contest_ranking_snapshots_contest_created" ON "contest_ranking_snapshots" USING btree ("contest_id","created_at");