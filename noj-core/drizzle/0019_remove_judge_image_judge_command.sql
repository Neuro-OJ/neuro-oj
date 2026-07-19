-- Migration: 0019_remove_judge_image_judge_command
-- Description: 移除单容器评测遗留字段，runtime_config 改为 NOT NULL
--
-- 变更：
-- 1. 删除 judge_image 列
-- 2. 删除 judge_command 列
-- 3. 删除 time_limit_ms 列（已移入 runtime_config.evaluator）
-- 4. 删除 memory_limit_mb 列（已移入 runtime_config.evaluator）
-- 5. runtime_config 改为 NOT NULL（所有题目必须使用双容器模式）
-- 6. 清理 runtime_config 的 CHECK 约束（不再允许 NULL）

-- 1. 删除 judge_image 列
ALTER TABLE problems DROP COLUMN IF EXISTS judge_image;

-- 2. 删除 judge_command 列
ALTER TABLE problems DROP COLUMN IF EXISTS judge_command;

-- 3. 删除 time_limit_ms 列
ALTER TABLE problems DROP COLUMN IF EXISTS time_limit_ms;

-- 4. 删除 memory_limit_mb 列
ALTER TABLE problems DROP COLUMN IF EXISTS memory_limit_mb;

-- 5. 清理 runtime_config 的 CHECK 约束（旧约束允许 NULL）
ALTER TABLE problems DROP CONSTRAINT IF EXISTS problems_runtime_config_check;

-- 6. 为已有 NULL runtime_config 的行设置默认值（生产环境不应有，防御性操作）
UPDATE problems SET runtime_config = '{
  "evaluator": {
    "image": "noj-evaluator-python",
    "command": "python3 /workspace/evaluate.py",
    "time_limit_ms": 5000,
    "memory_limit_mb": 512
  },
  "solution": {
    "image": "noj-solution-python",
    "entry": "submission_sample.py",
    "call_timeout_ms": 2000,
    "memory_limit_mb": 512
  }
}'::jsonb WHERE runtime_config IS NULL;

-- 7. runtime_config 改为 NOT NULL
ALTER TABLE problems ALTER COLUMN runtime_config SET NOT NULL;

-- 8. 添加新的 CHECK 约束（确保 runtime_config 是对象）
ALTER TABLE problems ADD CONSTRAINT problems_runtime_config_check
  CHECK (jsonb_typeof(runtime_config) = 'object');
