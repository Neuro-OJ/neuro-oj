CREATE TABLE "search_entries" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"search_vector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(body, '')), 'B')
  ) STORED,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"owner_id" text,
	"participant_ids" text[] DEFAULT '{}' NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"admin_only" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_search_entries_entity" ON "search_entries" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_search_entries_vector" ON "search_entries" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "idx_search_entries_title_trgm" ON "search_entries" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_search_entries_body_trgm" ON "search_entries" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_search_entries_owner" ON "search_entries" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_search_entries_participants" ON "search_entries" USING gin ("participant_ids");--> statement-breakpoint
CREATE INDEX "idx_search_entries_public" ON "search_entries" USING btree ("is_public");--> statement-breakpoint
CREATE INDEX "idx_search_entries_updated" ON "search_entries" USING btree ("updated_at");