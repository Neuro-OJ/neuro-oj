# Agent Note: 平台评测错误最多自动重试三次

Status: implemented

## Problem

Judge
的平台侧瞬时故障直接写回失败终态，用户需要手动重测；平台错误不能覆盖已有正式成绩。

## Decision

Judge 在最终结果推送前对 `platform_error`
原子重投原始任务，首次执行外最多重试三次。 计数按队列、提交、run
与重测序列保存在 Redis，保留七天，跨 Worker 和进程重启共享。 Lua 同时移除
processing 副本、递增计数并 LPUSH 入队，释放资源租约和用户 claim，
让其他已排队任务先执行。中间错误不推送 core，避免提前终结尝试或吊销 eval token。
成功、正式零分、WA/CE/TLE/MLE/RE 与主动取消直接走原有最终写回路径。
重试耗尽保留最后一次平台错误，沿用 core 不替换已有正式判定的规则。 Redis
失败时保留 processing 消息，由既有 sweeper 恢复。

## Alternatives considered

- 在单个 Worker 内循环：计数无法跨进程恢复，多次长评测会超过 processing
  超时且长期占用用户槽位。
- 每次失败创建新评测尝试：扩大到 core 数据库、派发与 token
  生命周期，不适合作为局部热修复。
- 修改任务协议携带重试次数：扩大跨模块契约，使用 Redis 可保持消息原样。

## Consequences

本次仅需更新 Judge，无数据库迁移或 core/UI
协议变更；历史已失败提交仍需要显式重测。
持续平台故障每轮最多执行四次，可能增加评测资源及 LLM 调用消耗。
计数七天后过期，极端情况下超过七天才恢复的旧队列消息会重新获得重试额度。 Redis
集成回归覆盖三次上限、连接切换、并发重复消息、原消息保留和独立 run，
单元回归覆盖平台错误分类与 Redis 连接失败。
