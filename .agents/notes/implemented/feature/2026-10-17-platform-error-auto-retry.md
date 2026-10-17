# Agent Note: 正式提交偶发平台错误自动重试（默认最多 3 次）

Status: implemented

## Problem

正式提交的评测尝试以 `result_kind = platform_error` 结束时（LLM 网关连接被断开、
Evaluator 总超时、judge 内部错误等），提交直接定为
`error`，选手只能找管理员手动重测。 线上实例：提交 `2de401c3-…` 评测中调用 LLM
报
`LLMError: LLM gateway 连接失败: Remote end closed connection without response`。

生产 10-15～10-17 的 platform_error
数据显示，其中同时混有**确定性**失败：选手代码缺
函数（`NotFoundError: function 'solve' not registered`）与 LLM 额度/计费错误
（`LLM gateway 返回 402`、`out_of_usage`）。这两类再跑结果相同，重试只会浪费评测资源
和 LLM 额度。

## Decision

- **重试判定**（`classifyPlatformErrorRetry`，`services/versioning/auto-retry.ts`）：
  judge 结果没有结构化错误码（SDK `LLMError` 的 status/error_code
  不进结果封套）， 因此在 core 侧对 `output` 尾部 8 KiB 做保守白名单匹配：
  - 拒绝特征优先：`not registered`、`LLM gateway 返回 4xx`、`out_of_usage`、
    quota、402/payment/billing、401/403/鉴权关键字；
  - 只有命中可重试特征才重试：`Evaluator 总超时`、`系统内部错误 (submission: …)`、
    `LLM gateway 连接失败`、`LLM gateway 返回 5xx`；
  - 未知错误与 core 判定的非法评分（`INVALID_SCORE`）默认不重试。
- **重试位置**：`saveEvaluationResult` 判定可重试后，给 `applyAttemptResult` 传
  `autoRetry`；平台错误分支在**同一事务、同一提交行锁**内调用
  `scheduleAutoRetryInTx`： 失败尝试保留 `error` 终态，`createAttempt`
  新建尝试（sequence 递增、`source=rejudge`、
  沿用失败尝试的冻结执行快照），提交保持 `pending`，不闪成 `error`。只有 judge
  回传的 结果启用；派发失败、sweeper 永久失败等内部路径不传
  `autoRetry`，语义不变。
- **次数持久化**：新尝试
  `task_snapshot.auto_retry = { count, retry_of, origin_source }`。
  判定只读失败尝试自身的快照，无进程内状态（满足多副本约束）；人工重测/升级的新尝试
  不带该标记，因此拥有独立的预算。上限为 runtime 设置
  `judge_platform_error_max_retries`（env
  `JUDGE_PLATFORM_ERROR_MAX_RETRIES`，默认 3， 范围 0–10，0 = 关闭）。
- **幂等**：`finishAttempt`
  只成功一次，重复/过时回调在建尝试前即被忽略，不会重复建 尝试，也不会重复派发。
- **派发**：
  - 普通提交：结果事务提交后由结果消费者调用 `dispatchAutoRetryAttempt`
    即时派发， 复用 sweeper 的 `rebuildPendingTask`
    与入队、失败收尾；瞬时失败保留 pending， 由 sweeper 兜底。sweeper 的 pending
    恢复超时改为以**活动尝试创建时间**为准
    （无尝试回退提交创建时间），避免老提交的新重试尝试在即时派发窗口内被重复入队。
  - 重测/升级任务产生的尝试：把条目改指向新尝试并退回 `pending`，由批任务 worker
    走既有派发路径（租约、退避、容量等待）；条目在重试结束前保持未完成，耗尽后才
    `failed`。
  - 初次提交链的重试沿用初次优先级（竞赛提交不降为 `low`）。
- **统计口径**：重试尝试按 `rejudge`
  来源落库，但初次提交链（`origin_source =
  initial`）的最终结果仍按首次结果计入统计缓存与端到端延迟指标；已调度重试的中间
  平台错误不计入。

## Alternatives considered

- **每次重试创建一个重测任务**：复用度高，但会在管理端任务列表制造大量系统任务，
  且派发要等 worker 轮询；放弃。
- **新增 `evaluation_attempts.source = 'auto_retry'` 或计数列**：需要迁移（CHECK
  约束 变更），热修复不值得；改用快照标记。
- **数连续 platform_error
  尝试数**：人工重测后预算会被历史错误吃掉，语义不对；放弃。
- **全部 platform_error
  都重试**：确定性错误（缺函数）与计费错误只会浪费资源与额度；
  改为白名单判定，未知错误默认不重试。

## Consequences

- 无数据库迁移；新增一个 runtime 配置项（已登记注册表与 `.env.example`）。
- 只需部署 noj-core；judge、gateway、UI 无需变更。
- 偶发平台错误最多额外消耗 3 次评测（含 LLM
  调用额度，每次重试按新尝试独立计算预算）。
- 判定依赖 judge/SDK 的输出文案；若文案变更，需同步 `auto-retry.ts` 的特征表
  （未知文案退化为"不重试"，不会误重试）。
- 待办（不在本次范围）：「选手缺函数」被判为 platform_error 是分类错误，应在
  SDK/judge 侧把 `NotFoundError`（选手未注册函数）映射为 `graded` 0 分。
