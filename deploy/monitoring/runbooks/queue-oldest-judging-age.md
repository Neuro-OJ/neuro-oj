# Runbook: 队列最老 judging 年龄

## 告警含义

`submissions` 表中最早进入 `judging` 状态的任务已超过 10 分钟未完成，
可能存在 Judge Worker 离线、任务卡死或结果消费者异常。

## 确认步骤

1. 查看 `noj_queue_oldest_judging_age_seconds` 与 `noj_judge_workers`。
2. 检查 Judge Worker 心跳、`noj_judge_active_tasks` 与孤儿容器数。
3. 检查结果消费者 `noj_result_consumer_up` 与结果队列积压。

## 缓解步骤

1. 若 Worker 离线，重启/扩容 Judge。
2. 若存在卡死任务，清理孤儿容器并按运维流程重投。
3. 若结果消费者异常，重启 noj-core 结果消费者。

## 恢复验证

- `noj_queue_oldest_judging_age_seconds` 回落至 600 秒以下。
- 告警自动恢复。
