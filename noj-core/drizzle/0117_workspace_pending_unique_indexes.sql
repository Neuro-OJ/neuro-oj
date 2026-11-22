CREATE UNIQUE INDEX "classroom_join_requests_pending_unique" ON "classroom_join_requests" USING btree ("classroom_id","user_id") WHERE "classroom_join_requests"."status" = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX "education_outbox_pending_refresh_unique" ON "education_outbox" USING btree ("domain_id","assignment_id",COALESCE("user_id", '')) WHERE "education_outbox"."event_type" = 'assignment.refresh' AND "education_outbox"."processed_at" IS NULL;
