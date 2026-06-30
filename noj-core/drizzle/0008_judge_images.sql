-- 评测镜像白名单表（issue #82）
-- 管理员配置允许使用的 Docker 评测镜像。
-- mode='exact' 时精确匹配指定镜像名（含标签）；
-- mode='all_versions' 时匹配镜像名（不含标签部分）的所有版本标签。
CREATE TABLE IF NOT EXISTS judge_images (
  id TEXT PRIMARY KEY,
  image TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'exact',
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT judge_images_mode_check CHECK (mode IN ('exact', 'all_versions'))
);
