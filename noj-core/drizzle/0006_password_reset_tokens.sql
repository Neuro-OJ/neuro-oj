-- 密码重置令牌表（issue #49）
--
-- 用于存储密码重置流程的短期令牌：
--   - token_hash 存 SHA-256 哈希，URL 传明文（OWASP 2025+ 接受）
--   - expires_at = created_at + 15 分钟
--   - used_at NULL = 未使用，原子消耗用单 SQL UPDATE 实现
--   - user_id FK CASCADE：用户删除时自动清理

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

-- 按 user_id 查表：用户重置历史查询
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
  ON password_reset_tokens (user_id);

-- 按 expires_at 查表：后续 lazy cleanup / 统计
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at
  ON password_reset_tokens (expires_at);
