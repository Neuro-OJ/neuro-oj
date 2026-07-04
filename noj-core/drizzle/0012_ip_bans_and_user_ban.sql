-- Issue #102：IP 黑名单 + 用户封禁
-- 1) users 表加 3 列（banned / banned_reason / banned_until）
-- 2) 新建 ip_bans 表
-- 3) 索引

-- 1) users.banned
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS banned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS banned_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS banned_until text;

-- 2) ip_bans 表
CREATE TABLE IF NOT EXISTS ip_bans (
  id            TEXT PRIMARY KEY,
  ip_or_cidr    TEXT NOT NULL,
  reason        TEXT NOT NULL DEFAULT '',
  expires_at    TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- 3) 索引
CREATE INDEX IF NOT EXISTS idx_ip_bans_ip_or_cidr
  ON ip_bans(ip_or_cidr);

CREATE INDEX IF NOT EXISTS idx_ip_bans_expires_at
  ON ip_bans(expires_at)
  WHERE expires_at IS NOT NULL;
