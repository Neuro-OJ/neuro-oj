-- Migration: 0021_fix_legacy_columns_and_history
-- Description: 兜底修复 problems 表历史迁移漂移遗留的 legacy 列与 runtime_config 约束
--
-- 背景：
-- 部分历史 DB（如从外部恢复 / 老 dump 加载）存在如下异常：
--   - __drizzle_migrations 表里 0019 记录存在但文件 hash 已不一致
--   - judge_image / judge_command / time_limit_ms / memory_limit_mb 列实际仍存在
--   - runtime_config 可能是 NULL 而代码层声明 NOT NULL
--   - 旧的 runtime_config CHECK 约束允许 NULL，与代码不匹配
--
-- Drizzle 0.45.2 仅按 folderMillis 比较决定是否执行迁移（不验证 SQL 内容 hash），
-- 因此不会自动重做 0019，导致 legacy 列长期残留，业务 INSERT 撞 NOT NULL 失败。
--
-- 本迁移做 idempotent 修复：
--   1. DROP COLUMN IF EXISTS 清理 legacy 列
--   2. 防御性 UPDATE 把 NULL runtime_config 补默认 jsonb
--   3. ALTER COLUMN ... SET NOT NULL 仅在当前 nullable 时执行
--   4. 重建 problems_runtime_config_check 约束（先 DROP 再 ADD，幂等）
--
-- 对新建 DB 无副作用（0019 已做对的事情，IF EXISTS / DO 块均跳过）。
-- 对历史脏 DB 起兜底作用。

-- 1. 清理 legacy 列（IF EXISTS 保证幂等）
ALTER TABLE problems DROP COLUMN IF EXISTS judge_image;
ALTER TABLE problems DROP COLUMN IF EXISTS judge_command;
ALTER TABLE problems DROP COLUMN IF EXISTS time_limit_ms;
ALTER TABLE problems DROP COLUMN IF EXISTS memory_limit_mb;

-- 2. 防御性补默认值（仅在 NULL 行）
DO $$
DECLARE
  null_count INTEGER;
BEGIN
  SELECT count(*) INTO null_count
    FROM problems
   WHERE runtime_config IS NULL;

  IF null_count > 0 THEN
    UPDATE problems
       SET runtime_config = '{
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
       }'::jsonb
     WHERE runtime_config IS NULL;

    RAISE NOTICE '0021: 已为 % 行补 runtime_config 默认值', null_count;
  END IF;
END $$;

-- 3. 仅在 runtime_config 仍 nullable 时升级为 NOT NULL
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'problems'
       AND column_name  = 'runtime_config'
       AND is_nullable  = 'YES'
  ) THEN
    ALTER TABLE problems ALTER COLUMN runtime_config SET NOT NULL;
    RAISE NOTICE '0021: runtime_config 已升级为 NOT NULL';
  END IF;
END $$;

-- 4. 重建 runtime_config 的 CHECK 约束（先 DROP 再 ADD，幂等）
ALTER TABLE problems DROP CONSTRAINT IF EXISTS problems_runtime_config_check;
ALTER TABLE problems ADD CONSTRAINT problems_runtime_config_check
  CHECK (runtime_config IS NULL OR jsonb_typeof(runtime_config) = 'object');
