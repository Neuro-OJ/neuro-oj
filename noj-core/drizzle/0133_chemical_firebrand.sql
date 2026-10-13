CREATE TABLE "education_notification_emails" (
	"notification_id" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" text NOT NULL,
	"lease_token" text,
	"leased_until" text,
	"completed_at" text,
	"last_error" text,
	CONSTRAINT "education_notification_emails_state_check" CHECK ("education_notification_emails"."state" IN ('pending', 'sent', 'skipped')),
	CONSTRAINT "education_notification_emails_attempts_check" CHECK ("education_notification_emails"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "education_notification_emails" ADD CONSTRAINT "education_notification_emails_notification_id_education_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "education_notifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_education_notification_emails_pending" ON "education_notification_emails" USING btree ("state","available_at","leased_until");
