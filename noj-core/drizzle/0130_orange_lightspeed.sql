-- #698：下线站内私信与第三方内容审核。先清理引用私信的举报、搜索条目、待处理索引任务与配置项。
DELETE FROM "community_reports" WHERE "content_type" = 'message' OR "message_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "search_entries" WHERE "entity_type" = 'message';--> statement-breakpoint
DELETE FROM "background_tasks" WHERE "task_type" = 'search.index' AND "payload"->>'entity_type' = 'message';--> statement-breakpoint
DELETE FROM "system_settings" WHERE "key" IN ('private_messaging_enabled', 'content_review_enabled', 'content_review_provider', 'content_review_provider_key', 'content_review_provider_secret', 'content_review_risk_threshold', 'content_review_review_threshold', 'content_review_async_enabled', 'content_review_timeout_ms');--> statement-breakpoint
ALTER TABLE "community_reports" DROP CONSTRAINT "community_reports_workspace_check";--> statement-breakpoint
ALTER TABLE "community_reports" DROP CONSTRAINT "community_reports_target_check";--> statement-breakpoint
ALTER TABLE "community_reports" DROP CONSTRAINT "community_reports_message_id_messages_id_fk";--> statement-breakpoint
DROP INDEX "idx_community_reports_message";--> statement-breakpoint
ALTER TABLE "community_reports" DROP COLUMN "message_id";--> statement-breakpoint
ALTER TABLE "search_entries" DROP COLUMN "deleted_by_user_ids";--> statement-breakpoint
DROP TABLE "content_review_queue" CASCADE;--> statement-breakpoint
DROP TABLE "conversation_preferences" CASCADE;--> statement-breakpoint
DROP TABLE "conversation_reads" CASCADE;--> statement-breakpoint
DROP TABLE "message_deletions" CASCADE;--> statement-breakpoint
DROP TABLE "message_reactions" CASCADE;--> statement-breakpoint
DROP TABLE "messages" CASCADE;--> statement-breakpoint
DROP TABLE "conversations" CASCADE;--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_workspace_check" CHECK ("community_reports"."content_type" IN ('post', 'comment') AND "community_reports"."domain_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_target_check" CHECK (num_nonnulls("community_reports"."post_id", "community_reports"."comment_id") = 1);
