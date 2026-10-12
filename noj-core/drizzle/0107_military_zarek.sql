-- 删除旧客观题小题表 objective_questions（Handbook §6.4/§8.1 第 8 步）。
--
-- 前置条件（删表前必须已满足，逐条核对）：
--   1. 小题的**运行期事实源**已是 `problem_drafts.content.questions` /
--      `problem_versions.content.questions`：读写路径（catalog 路由、objective
--      域读取与判卷、题包导入）在批次 2d 全部切换完成，本表不再被任何运行期代码引用；
--   2. 存量小题已随迁移基线与题包导入写入版本快照（迁移 `0103` / `0106` 已按
--      现有 UUID 作为稳定 key 快照）；
--   3. `legacy_unknown` 存量提交（无提交时版本）的卷面无法还原，按未作答处理
--      （§8.1「历史信息无法恢复，保留未知状态」），原始 answers 仍保留可读。
--
-- 若仍需回查旧小题数据，请在升级前自行备份本表（`CREATE TABLE
-- objective_questions_backup AS TABLE objective_questions;`）——生产升级流程
-- 已要求先做整库备份（§8.3 第 4 步）。

DROP TABLE "objective_questions" CASCADE;
