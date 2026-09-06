CREATE TABLE "email_delivery_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"recipient_hash" text NOT NULL,
	"recipient_masked" text NOT NULL,
	"reason_code" text,
	"reason" text,
	"occurred_at" text NOT NULL,
	"received_at" text NOT NULL,
	CONSTRAINT "email_delivery_events_provider_event_unique" UNIQUE("provider","provider_event_id"),
	CONSTRAINT "email_delivery_events_event_type_check" CHECK ("email_delivery_events"."event_type" IN ('delivery', 'temporary_failure', 'permanent_bounce', 'complaint'))
);
--> statement-breakpoint
CREATE TABLE "email_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient_hash" text NOT NULL,
	"recipient_masked" text NOT NULL,
	"reason" text NOT NULL,
	"provider" text NOT NULL,
	"source_event_id" text NOT NULL,
	"suppressed_at" text NOT NULL,
	"cleared_at" text,
	"cleared_by" text
);
--> statement-breakpoint
CREATE INDEX "idx_email_delivery_events_recipient_hash" ON "email_delivery_events" USING btree ("recipient_hash");--> statement-breakpoint
CREATE INDEX "idx_email_delivery_events_occurred_at" ON "email_delivery_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "idx_email_suppressions_recipient_hash" ON "email_suppressions" USING btree ("recipient_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "email_suppressions_active_recipient_unique" ON "email_suppressions" USING btree ("recipient_hash") WHERE "email_suppressions"."cleared_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_email_suppressions_suppressed_at" ON "email_suppressions" USING btree ("suppressed_at");