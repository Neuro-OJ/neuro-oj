/**
 * 批量任务条目派发（Handbook §5.7）。
 *
 * worker 领取条目（`preparing` + lease）后按以下顺序执行：
 *
 * 1. **重新检查源**：源提交/客观题提交已删除 → `skipped` + `SOURCE_DELETED`；
 *    源仍在评测（在途尝试不是本条目）→ `skipped` + `SOURCE_JUDGING`（允许之后重试）；
 * 2. **目标版本固定**：`target_version_id` 在受理事务里已解析；`submitted` 模式
 *    遇到未知历史版本 → `skipped` + `LEGACY_VERSION_UNKNOWN`；
 * 3. **平台安全与交付物复检**：语言/提交模式必须被目标版本接受，artifact 对象必须
 *    存在且不超过目标版本上限——违反时 `failed` + 机器可读原因码，保留历史判定；
 * 4. **创建新尝试**：`sequence` 递增，旧尝试保留；任务与 LLM token 绑定本次尝试；
 * 5. **派发**：MQ 容量不足 → 等待下轮（不计失败）；网络失败 → 指数退避重试。
 *
 * 任务配置**只**来自目标版本内容，绝不读取题目当前投影：否则"用 V1 重测"会在
 * 题目发布 V2 后拿到 V2 的配置。
 */

// 门面导出：保持原有对外符号集合与导入路径不变
export type {
  DispatchOutcome,
  DispatchSource,
  JobUpgradeContext,
} from "./dispatch-types.ts";
export {
  runSubmissionJobWorkerOnce,
  startSubmissionJobWorker,
  stopSubmissionJobWorker,
  SUBMISSION_JOB_WORKER_INTERVAL_MS,
} from "./dispatch-worker.ts";
export { dispatchJobItem } from "./dispatch-item.ts";
