-- 提交重测序列号（issue #80 审查意见 #1）
--
-- 每次重测递增 rejudge_seq，用于区分并丢弃旧评测结果。
-- saveEvaluationResult 收到结果后比较 JudgeResult.rejudge_seq 与
-- submissions.rejudge_seq，若结果序列号小于当前值则丢弃（忽略）。
-- 初始为 0（首次提交不递增），重测时 +1。
ALTER TABLE submissions ADD COLUMN rejudge_seq integer NOT NULL DEFAULT 0;
