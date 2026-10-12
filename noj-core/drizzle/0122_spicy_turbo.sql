ALTER TABLE "education_disabled_intervals" ALTER COLUMN "domain_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assignment_item_history" ADD COLUMN "binding_history_id" text;--> statement-breakpoint
ALTER TABLE "assignment_item_history" ADD CONSTRAINT "assignment_item_history_binding_history_id_problem_binding_history_id_fk" FOREIGN KEY ("binding_history_id") REFERENCES "problem_binding_history"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "education_outbox_pending_refresh_unique" ON "education_outbox" USING btree ("domain_id","assignment_id",COALESCE("user_id", '')) WHERE "education_outbox"."event_type" = 'assignment.refresh' AND "education_outbox"."processed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "assignment_item_history" ADD CONSTRAINT "assignment_item_history_binding_change_unique" UNIQUE("item_id","binding_history_id");
