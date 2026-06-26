-- 区分标准题与 SPJ 题：problems 表新增 judge_type 列与 CHECK 约束。
--
-- 标准题（judge_type='standard'）由 noj-judge 原生 Rust 执行器 stdout diff 评分，
-- 省掉 python3 /tmp/evaluate.py 启动开销。SPJ 题（judge_type='special'）保留
-- 现有的 python3 evaluate.py 路径。
--
-- 已有样例题 1003 是 A+B 标准题，迁移中显式标记为 standard。
ALTER TABLE problems ADD COLUMN judge_type text NOT NULL DEFAULT 'special';--> statement-breakpoint
ALTER TABLE problems ADD CONSTRAINT problems_judge_type_check CHECK (judge_type IN ('standard', 'special'));--> statement-breakpoint
UPDATE problems SET judge_type = 'standard' WHERE id = '1003';