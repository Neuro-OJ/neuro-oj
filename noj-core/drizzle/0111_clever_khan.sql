CREATE TABLE "storage_object_reservations" (
	"reservation_id" text PRIMARY KEY NOT NULL,
	"storage_url" text NOT NULL,
	"reserved_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "query_projection_revisions" ADD COLUMN "materialized_at" text;--> statement-breakpoint
CREATE INDEX "idx_storage_object_reservations_url" ON "storage_object_reservations" USING btree ("storage_url");--> statement-breakpoint
CREATE INDEX "idx_storage_object_reservations_expires" ON "storage_object_reservations" USING btree ("expires_at");