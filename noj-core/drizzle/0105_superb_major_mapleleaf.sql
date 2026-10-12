-- 退役旧评测结果表（Handbook §6.5、§8.1 第 8 步）。
--
-- 前置条件已在本分支完成：
--   * 全部运行期**读取**迁到 `evaluation_attempts` 终态 / 分版本当前判定 / 有效成绩投影
--     （提交列表与详情、队列、站点统计、个人主页、数据导出、竞赛题目通过状态、
--      结算就绪、Kaggle 计分）；
--   * 结果写入**双写已移除**，评测事实唯一来源是尝试与投影；
--   * 历史结果已在 `0103` 回填为 `legacy_import` 尝试 + 未知版本桶判定；
--   * 用户榜单物化视图已在 `0104` 重建到 `submissions.is_accepted`。
DROP TABLE "evaluation_results" CASCADE;
