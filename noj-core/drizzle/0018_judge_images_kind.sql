-- 双容器 Evaluator/Solution 镜像分类（openspec/changes/dual-container-judge §5）
--
-- `judge_images` 表新增 `kind` 字段，区分镜像用途：
--   - 'evaluator'：单容器 / 双容器 Evaluator 角色
--   - 'solution' ：双容器 Solution 角色
--
-- 历史记录迁移：所有现存镜像默认为 'evaluator'。
-- admin 应在迁移后手动将 `noj-solution-*` 镜像的 kind 改为 'solution'。

ALTER TABLE "judge_images" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'evaluator';

-- 旧 CHECK 约束被替换（如果存在）
ALTER TABLE "judge_images" DROP CONSTRAINT IF EXISTS "judge_images_mode_check";
ALTER TABLE "judge_images" ADD CONSTRAINT "judge_images_kind_check" CHECK ("kind" IN ('evaluator', 'solution'));

-- 历史数据全部标记为 'evaluator'（DEFAULT 已覆盖；显式 UPDATE 一次以保证）
UPDATE "judge_images" SET "kind" = 'evaluator' WHERE "kind" IS NULL;