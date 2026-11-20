-- 为 submissions、evaluation_results、check_ins、problems 添加外键级联策略。
-- 历史评测数据不应因用户/题目删除而丢失，因此 submissions 使用 SET NULL 保留记录，
-- evaluation_results 随 submission CASCADE 删除（依赖数据），check_ins 随用户删除。

-- problems_owner_id_fkey 由 0004_problem_owner_type.sql 创建，当时未指定 ON DELETE
-- SET NULL：user 被删除时，其创建的 problems 保留但 owner 置空
ALTER TABLE problems
  DROP CONSTRAINT problems_owner_id_fkey,
  ADD CONSTRAINT problems_owner_id_fkey
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE submissions
  DROP CONSTRAINT submissions_user_id_fkey,
  ADD CONSTRAINT submissions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE submissions
  DROP CONSTRAINT submissions_problem_id_fkey,
  ADD CONSTRAINT submissions_problem_id_fkey
    FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE SET NULL;

ALTER TABLE evaluation_results
  DROP CONSTRAINT evaluation_results_submission_id_fkey,
  ADD CONSTRAINT evaluation_results_submission_id_fkey
    FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE;

ALTER TABLE check_ins
  DROP CONSTRAINT check_ins_user_id_fkey,
  ADD CONSTRAINT check_ins_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
