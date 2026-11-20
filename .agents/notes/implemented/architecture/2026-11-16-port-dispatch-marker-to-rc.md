# Agent Note: 把评测派发标记与 judging 孤儿对账移植到 rc/v0.11

Status: implemented

## Problem

`main` 上的 #716（评测链路派发标记与孤儿对账）没有进入 `rc/v0.11`。rc 已经有
事务内登记的 `evaluation.dispatch` 持久任务，解决了「受理时 Redis 不可用」；但
#716 实际修的三件事在 rc 上仍然存在：

- 提交已是 `judging`、任务却从 Redis 丢失（Redis 重启丢数据、任务在 Judge 侧
  丢失）时，没有任何恢复路径，提交永远停在 `judging`，只能由管理员手动处理；
- 任务已入队、进程死在「状态更新为 judging」之前时，提交仍是 `pending`。rc 上有
  三条路径会重推同一个 run：受理请求的内联派发、持久派发任务、pending sweeper；
- sweeper 的去重状态只在进程内存里，多副本会同时恢复同一条 pending 提交。

## Decision

按 #716 的设计移植到 `modules/evaluations/mq/`，不重新设计：

- 以活动尝试的 `run_id` 为键写 Redis 派发标记。Producer 在「容量检查 + 入队」的
  同一条 Lua 脚本里写 `queued`；恢复器先用 `NX` 抢占 60 秒的
  `dispatching`，失败时
  按比较并删除释放。结果落库、取消自测、管理员移出队列时清理，24 小时 TTL 兜底。
- sweeper 新增 `judging` 对账：超过一次完整 processing 超时、活动尝试仍为
  `queued/judging`、没有未完成批任务条目的提交，先用 `MGET` 过滤仍有标记的行，
  再复核主队列、processing 与结果队列（在途的补写标记），其余才按尝试绑定的版本
  重建任务。对账保留原始 `judge_started_at`。
- 恢复动作记入 `noj_submission_recovery_total{type,result}`。

rc 特有的适配只有一处：`handleEvaluationDispatchTask` 推送前同样先抢占标记。
发现 `queued` 时只补齐状态并以 `already_dispatched` 结束；发现 `dispatching`
时以 `dispatch_in_progress` 结束，由 pending 恢复兜底。否则持久任务会在崩溃窗口
内把内联派发已经入队的 run 再推一次。

## Alternatives considered

- 只移植 `judging` 对账、不引入标记：对账必须靠标记区分「长任务仍在途」与「任务
  已丢失」，没有标记就只能扫描全部队列内容，或者把正常长任务重复派发。
- 把内联派发删掉、只留持久任务：能消掉一条重推路径，但会让每次提交多等一个
  worker 轮询周期，且属于受理链路的行为变更，不适合放进 RC 收尾阶段。
- 留到 0.11.0 之后：0.10 线已带这个修复，0.11 不带就是可靠性回退。

## Consequences

- 每次派发多写一个 Redis
  key，入队与标记原子完成；无迁移、无新依赖、无新环境变量。
- 批任务条目（重测 / 升级）仍由自己的租约与退避负责，对账与 pending 恢复都排除
  它们。
- 自测只参与 pending 恢复的防重，不参与 `judging` 对账（与 #716 一致）。
- 测试夹具里「先创建提交、再手动改回 pending」的写法会留下 `queued` 标记；要模拟
  「任务确实没派发」必须同时清掉标记。
- `noj_submission_recovery_total` 尚未接入仪表盘与告警。
