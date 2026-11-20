-- #698：下线社区关注、点赞与收藏。清理对应配置项与 RBAC 权限（role_permissions 级联删除），再删除四张表。
DELETE FROM "system_settings" WHERE "key" IN ('community_reactions_enabled', 'community_bookmarks_enabled', 'community_follows_enabled');--> statement-breakpoint
DELETE FROM "permissions" WHERE "resource" = 'community' AND "action" IN ('react', 'follow');--> statement-breakpoint
DROP TABLE "community_bookmarks" CASCADE;--> statement-breakpoint
DROP TABLE "community_comment_likes" CASCADE;--> statement-breakpoint
DROP TABLE "community_follows" CASCADE;--> statement-breakpoint
DROP TABLE "community_post_likes" CASCADE;
