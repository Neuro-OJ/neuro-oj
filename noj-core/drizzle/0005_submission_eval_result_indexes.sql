-- 修复 issue 64 评论 §6.4：补齐分页查询所需的索引
--
-- 1. submissions (user_id, created_at) 复合索引：
--    优化 "我的提交历史按时间倒序" 查询
-- 2. evaluation_results (created_at) 索引：
--    优化评测结果按时间分页与归档
--
-- 注意：submissions.idx_submissions_user_id 和 idx_submissions_created_at
-- 已是独立索引；本次新增复合索引以覆盖最常见的组合查询。

CREATE INDEX IF NOT EXISTS idx_submissions_user_id_created_at
  ON submissions (user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_eval_results_created_at
  ON evaluation_results (created_at);
