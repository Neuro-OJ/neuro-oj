-- 全文搜索基础设施（openspec/issues #100）
--
-- 在不引入 Elasticsearch 的前提下，复用 PostgreSQL 内置能力实现题目 + 用户全文搜索：
--   - problems 表新增 search_vector 列 + BEFORE INSERT/UPDATE 触发器自动维护
--   - pg_trgm 扩展 + GIN 索引支持中文三元组匹配与短字符串模糊匹配
--   - users 表 username/email 加 trigram GIN 索引（不引入 tsvector）
--
-- display_id 由 `type || number::text` 在应用层拼接（services/problems.ts:173），
-- trigger 同步索引拼接后的字符串以支持 P1001/U42 类短查询。

-- 1. pg_trgm 扩展（内置于 postgres:16-alpine；不存在时静默跳过）
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. problems.search_vector 列（由 trigger 维护，应用层只读）
ALTER TABLE "problems" ADD COLUMN "search_vector" tsvector;

-- 3. trigger 函数：拼接 title (A) + description (B) + display_id (A)
CREATE OR REPLACE FUNCTION "problems_search_vector_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."search_vector" :=
    setweight(to_tsvector('simple', coalesce(NEW."title", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW."description", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW."type" || NEW."number"::text, '')), 'A');
  RETURN NEW;
END;
$$;

-- 4. trigger：BEFORE INSERT/UPDATE OF title, description, type, number
DROP TRIGGER IF EXISTS "trg_problems_search_vector" ON "problems";
CREATE TRIGGER "trg_problems_search_vector"
  BEFORE INSERT OR UPDATE OF "title", "description", "type", "number" ON "problems"
  FOR EACH ROW
  EXECUTE FUNCTION "problems_search_vector_update"();

-- 5. GIN 索引
-- tsvector 主索引（覆盖 to_tsquery 路径）
CREATE INDEX "idx_problems_search_vector" ON "problems" USING gin ("search_vector");

-- display_id 短查询兜底（覆盖 ILIKE '%1001%' 路径，由 pg_trgm 加速）
CREATE INDEX "idx_problems_display_id_trgm" ON "problems"
  USING gin (("type" || "number"::text) gin_trgm_ops);

-- users 字段 trigram 索引（覆盖 username / email 模糊匹配 + similarity()）
CREATE INDEX "idx_users_username_trgm" ON "users" USING gin ("username" gin_trgm_ops);
CREATE INDEX "idx_users_email_trgm" ON "users" USING gin ("email" gin_trgm_ops);

-- 6. 回填历史 search_vector
-- UPDATE 自身不会触发 trigger 对 search_vector 的修改（未在 OF 列表），
-- 但 BEFORE INSERT OR UPDATE 触发器会在任何 UPDATE 时执行，对未列在 OF 的列也生效。
-- 因此用一个不会改变可见值的 UPDATE 强制全表回填。
UPDATE "problems" SET "title" = "title";