-- Migration 0004：题目表新增所有者、类型、题号字段
-- 为 U/P 双题库拆分做准备

-- 1. 题号字段（每个 type 独立编号，INTEGER 支持 MAX 聚合）
ALTER TABLE problems ADD COLUMN number INTEGER;
UPDATE problems SET number = CAST(id AS INTEGER) WHERE number IS NULL;
ALTER TABLE problems ALTER COLUMN number SET NOT NULL;

-- 2. 所有者字段（默认归 root 用户 UID=0）
ALTER TABLE problems ADD COLUMN owner_id TEXT NOT NULL DEFAULT '0' REFERENCES users(id);

-- 3. 题目类型字段（U=用户题库, P=主题库）
ALTER TABLE problems ADD COLUMN type TEXT NOT NULL DEFAULT 'U';

-- 4. 约束
ALTER TABLE problems ADD CONSTRAINT problems_type_check CHECK (type IN ('U', 'P'));
ALTER TABLE problems ADD CONSTRAINT problems_type_number_unique UNIQUE (type, number);

-- 5. 已有 seed 样例题（1001/1002/1003）归为 P 型，归 root 所有
UPDATE problems SET type = 'P', owner_id = '0' WHERE id IN ('1001', '1002', '1003');
