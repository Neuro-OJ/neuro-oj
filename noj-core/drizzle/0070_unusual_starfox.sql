-- #453：ILIKE 子串搜索需要 pg_trgm 提供 gin_trgm_ops。
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX "idx_community_posts_title_trgm" ON "community_posts" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_community_posts_content_trgm" ON "community_posts" USING gin ("content" gin_trgm_ops);
