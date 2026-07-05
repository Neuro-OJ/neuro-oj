-- 系统设置 KV 表（issue #99）
-- 管理员运行时可变配置持久化层。运行时读取优先级：
--   1. system_settings.value（DB，admin 可改）
--   2. envFallback（启动期快照，env 配置）
--   3. SETTING_DEFINITIONS 中声明的 default（兜底）
--
-- 写入由 service 层做严格 type 校验 + 敏感字段掩码。
-- 审计日志走 console.log("[admin] ...")，issue #101 落库后迁移。
CREATE TABLE IF NOT EXISTS system_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,                  -- JSON 编码字符串
  description TEXT NOT NULL DEFAULT '',
  is_secret   BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_system_settings_updated_at
  ON system_settings(updated_at DESC);
