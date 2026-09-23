-- 移除 Provider 级默认模型：默认模型改由 noj-core 平台设置（llm_default_model）统一决定。
-- 运行时转发本就不读 provider.model；此列为死列。破坏性变更，升级前须备份。
ALTER TABLE llm_providers DROP COLUMN IF EXISTS model;
