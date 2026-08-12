ALTER TABLE "community_notifications" DROP CONSTRAINT "community_notifications_type_check";--> statement-breakpoint
CREATE INDEX "idx_contest_clarifications_contest" ON "contest_clarifications" USING btree ("contest_id","created_at");--> statement-breakpoint
ALTER TABLE "community_notifications" ADD CONSTRAINT "community_notifications_type_check" CHECK ("community_notifications"."type" IN ('reply', 'like', 'follow', 'moderation', 'clarification'));
