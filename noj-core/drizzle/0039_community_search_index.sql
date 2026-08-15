-- 社区搜索性能修复（NOJ-083）：
-- 为 searchCommunity 中重复使用的 FTS 表达式建立 GIN 索引，
-- 避免每次搜索都在 WHERE 内现算 tsvector 并全表扫描。
CREATE INDEX IF NOT EXISTS idx_community_posts_search_fts
  ON community_posts
  USING GIN (to_tsvector('simple', coalesce(title, '') || ' ' || content));
