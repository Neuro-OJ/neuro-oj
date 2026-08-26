ALTER TABLE "community_notifications" DROP CONSTRAINT "community_notifications_type_check";--> statement-breakpoint
ALTER TABLE "community_reports" ADD COLUMN "content_type" text DEFAULT 'post' NOT NULL;--> statement-breakpoint
ALTER TABLE "community_reports" ADD COLUMN "sanction_id" text;--> statement-breakpoint
ALTER TABLE "community_reports" ADD COLUMN "ban_id" text;--> statement-breakpoint
ALTER TABLE "community_reports" ADD COLUMN "category" text DEFAULT '其他' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_bans" ADD COLUMN "scope" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_sanction_id_community_sanctions_id_fk" FOREIGN KEY ("sanction_id") REFERENCES "public"."community_sanctions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_ban_id_user_bans_id_fk" FOREIGN KEY ("ban_id") REFERENCES "public"."user_bans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_notifications" ADD CONSTRAINT "community_notifications_type_check" CHECK ("community_notifications"."type" IN ('reply', 'like', 'follow', 'moderation', 'clarification', 'report', 'ban'));--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_category_check" CHECK ("community_reports"."category" IN ('违法违规', '人身侵权', '涉嫌欺诈', '侵权抄袭', '垃圾信息', '站外风险引流', 'AI生成内容问题', '其他'));--> statement-breakpoint
ALTER TABLE "user_bans" ADD CONSTRAINT "user_bans_scope_check" CHECK ("user_bans"."scope" IN ('platform', 'social'));