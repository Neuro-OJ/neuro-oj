CREATE TABLE "sse_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_sse_events_channel_id" ON "sse_events" USING btree ("channel","id");