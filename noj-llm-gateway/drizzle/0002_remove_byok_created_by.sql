-- 移除 BYOK：删除用户自建 Provider（含加密 Key）并删除归属列。
-- 用户 Provider 是 created_by <> '0' 的唯一来源；平台 Provider（'0'）保留。
DELETE FROM llm_providers WHERE created_by <> '0';
ALTER TABLE llm_providers DROP COLUMN IF EXISTS created_by;
