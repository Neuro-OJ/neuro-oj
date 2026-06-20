CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  level INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories (parent_id);
CREATE INDEX IF NOT EXISTS idx_categories_level ON categories (level);

CREATE TABLE IF NOT EXISTS problems_categories (
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (problem_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_problems_categories_category_id ON problems_categories (category_id);

ALTER TABLE problems ADD CONSTRAINT check_difficulty CHECK (difficulty IN ('easy', 'medium', 'hard'));
