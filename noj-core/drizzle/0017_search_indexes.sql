-- 全局搜索（issue #100）：
-- - problems 加 search_vector 列：title 权重 A + display_id(type+number) 权重 B
-- - users 加 search_vector 列：username 权重 A + email 权重 B
-- - 两表均建 tsvector GIN 索引 + pg_trgm GIN 索引（中英文混合友好）

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- problems：search_vector 列 + 索引
ALTER TABLE problems
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple',
      coalesce(type, '') || ' ' || coalesce(number::text, '')
    ), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_problems_search_vector ON problems USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_problems_title_trgm ON problems USING GIN (title gin_trgm_ops);

-- users：search_vector 列 + 索引
ALTER TABLE users
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(username, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(email, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_users_search_vector ON users USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_users_username_trgm ON users USING GIN (username gin_trgm_ops);
