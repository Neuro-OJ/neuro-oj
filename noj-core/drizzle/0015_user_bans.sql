-- Issue #102 / user-ban-table：user_bans 表 + 从 users 表移除封禁列
-- 0012 在 users 表加了三列但未投入生产，0013 用 user_bans 表替代

CREATE TABLE IF NOT EXISTS user_bans (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL DEFAULT '',
  banned_until  TEXT,
  banned_at     TEXT NOT NULL,
  banned_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  unbanned_at   TEXT,
  unbanned_by   TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_user_bans_user ON user_bans(user_id);
CREATE INDEX IF NOT EXISTS idx_user_bans_active ON user_bans(user_id) WHERE unbanned_at IS NULL;

ALTER TABLE users DROP COLUMN IF EXISTS banned;
ALTER TABLE users DROP COLUMN IF EXISTS banned_reason;
ALTER TABLE users DROP COLUMN IF EXISTS banned_until;
