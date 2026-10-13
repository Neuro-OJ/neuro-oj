-- 原单域社区的板块与处罚在扩展迁移执行时可能尚未初始化 main。
-- 只对历史空值完成该已知归属；既有显式域不改写。
UPDATE community_boards SET domain_id = '00000000-0000-4000-8000-000000000001'
WHERE domain_id IS NULL;--> statement-breakpoint
UPDATE community_sanctions SET domain_id = '00000000-0000-4000-8000-000000000001'
WHERE domain_id IS NULL;--> statement-breakpoint
UPDATE community_posts p SET domain_id = b.domain_id
FROM community_boards b WHERE p.board_id = b.id AND p.domain_id IS NULL;--> statement-breakpoint
UPDATE community_posts p SET domain_id = b.domain_id
FROM domain_problem_bindings b WHERE p.domain_problem_binding_id = b.id AND p.domain_id IS NULL;--> statement-breakpoint
-- 未绑定的旧题解仅能是原默认题库；其他源域不能推导使用域。
UPDATE community_posts p SET domain_id = '00000000-0000-4000-8000-000000000001'
WHERE p.domain_id IS NULL AND (p.type = 'moment' OR (p.type = 'solution' AND EXISTS (
  SELECT 1 FROM problems source WHERE source.id = p.problem_id
    AND source.domain_id = '00000000-0000-4000-8000-000000000001'
)));--> statement-breakpoint
UPDATE community_posts p SET domain_problem_binding_id = b.id
FROM domain_problem_bindings b WHERE p.type = 'solution'
  AND p.domain_problem_binding_id IS NULL AND b.domain_id = p.domain_id
  AND b.problem_id = p.problem_id;--> statement-breakpoint
UPDATE community_comments c SET domain_id = p.domain_id
FROM community_posts p WHERE c.post_id = p.id AND c.domain_id IS NULL;--> statement-breakpoint
UPDATE community_reports r SET domain_id = p.domain_id
FROM community_posts p WHERE r.post_id = p.id AND r.domain_id IS NULL;--> statement-breakpoint
UPDATE community_reports r SET domain_id = c.domain_id
FROM community_comments c WHERE r.comment_id = c.id AND r.domain_id IS NULL;--> statement-breakpoint
UPDATE community_moderation_actions a SET domain_id = p.domain_id
FROM community_posts p WHERE a.target_type = 'post' AND a.target_id = p.id
  AND a.domain_id IS NULL;--> statement-breakpoint
UPDATE community_moderation_actions a SET domain_id = c.domain_id
FROM community_comments c WHERE a.target_type = 'comment' AND a.target_id = c.id
  AND a.domain_id IS NULL;--> statement-breakpoint
UPDATE community_notifications n SET domain_id = p.domain_id
FROM community_posts p WHERE n.post_id = p.id AND n.domain_id IS NULL;--> statement-breakpoint
UPDATE community_notifications n SET domain_id = c.domain_id
FROM community_comments c WHERE n.comment_id = c.id AND n.domain_id IS NULL;--> statement-breakpoint
UPDATE community_notifications n SET domain_id = r.domain_id
FROM community_reports r WHERE n.type = 'report' AND n.data->>'report_id' = r.id
  AND n.domain_id IS NULL;--> statement-breakpoint
UPDATE community_notifications n SET domain_id = c.domain_id
FROM contests c WHERE n.type = 'clarification' AND n.data->>'contest_id' = c.id
  AND n.domain_id IS NULL;--> statement-breakpoint
DROP INDEX "community_boards_legacy_slug_unique";--> statement-breakpoint
ALTER TABLE "community_boards" ALTER COLUMN "domain_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "community_comments" ALTER COLUMN "domain_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "community_posts" ALTER COLUMN "domain_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "community_sanctions" ALTER COLUMN "domain_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "community_notifications" ADD CONSTRAINT "community_notifications_workspace_post_fk" FOREIGN KEY ("post_id","domain_id") REFERENCES "community_posts"("id","domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_notifications" ADD CONSTRAINT "community_notifications_workspace_comment_fk" FOREIGN KEY ("comment_id","domain_id") REFERENCES "community_comments"("id","domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_workspace_post_fk" FOREIGN KEY ("post_id","domain_id") REFERENCES "community_posts"("id","domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_workspace_comment_fk" FOREIGN KEY ("comment_id","domain_id") REFERENCES "community_comments"("id","domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_moderation_actions" ADD CONSTRAINT "community_moderation_actions_workspace_check" CHECK (("community_moderation_actions"."target_type" IN ('message', 'user_ban') AND "community_moderation_actions"."domain_id" IS NULL)
        OR ("community_moderation_actions"."target_type" NOT IN ('message', 'user_ban') AND "community_moderation_actions"."domain_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "community_notifications" ADD CONSTRAINT "community_notifications_workspace_check" CHECK (("community_notifications"."type" IN ('reply', 'like', 'moderation', 'clarification') AND "community_notifications"."domain_id" IS NOT NULL)
        OR ("community_notifications"."type" IN ('follow', 'ban') AND "community_notifications"."domain_id" IS NULL)
        OR "community_notifications"."type" = 'report');--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_binding_required_check" CHECK (("community_posts"."type" = 'solution' AND "community_posts"."domain_problem_binding_id" IS NOT NULL)
        OR ("community_posts"."type" <> 'solution' AND "community_posts"."domain_problem_binding_id" IS NULL));--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_workspace_check" CHECK (("community_reports"."content_type" = 'message' AND "community_reports"."domain_id" IS NULL)
        OR ("community_reports"."content_type" IN ('post', 'comment') AND "community_reports"."domain_id" IS NOT NULL));
