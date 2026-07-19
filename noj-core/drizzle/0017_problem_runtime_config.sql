-- 双容器 RuntimeConfig 存储（openspec/changes/dual-container-judge §4）
--
-- problems 表新增 runtime_config JSONB 列：
--   - NULL：单容器题目（旧路径，向后兼容）
--   - 非 NULL：双容器题目（evaluator + solution 各自 RuntimeConfig）
--
-- 历史数据：所有现存题目 runtime_config = NULL（保持单容器路径）。
-- 结构校验仅做最基础的 jsonb_typeof 检查；语义校验由 admin API 完成。

ALTER TABLE "problems" ADD COLUMN IF NOT EXISTS "runtime_config" jsonb;

-- 约束：runtime_config 必须为 NULL 或 JSON object
ALTER TABLE "problems" ADD CONSTRAINT "problems_runtime_config_check"
  CHECK ("runtime_config" IS NULL OR jsonb_typeof("runtime_config") = 'object');

-- 索引：按 runtime_config IS NOT NULL 过滤（任务分流时常用）
CREATE INDEX "problems_runtime_config_present_idx"
  ON "problems" (id)
  WHERE "runtime_config" IS NOT NULL;