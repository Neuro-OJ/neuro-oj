# Runbook: 队列最老 pending 年龄

## 告警含义

评测 pending 队列中存在长时间未被领取的任务。

## 确认步骤

1. 查看 `noj_queue_oldest_pending_age_seconds`。
2. 检查 Judge Worker 是否在线、消费者是否存活。

## 缓解步骤

1. 若 Worker 离线，重启/扩容 Judge。
2. 若消费者异常，重启 noj-core 结果消费者。

## 恢复验证

- 最老 pending 年龄回落。
- 告警自动恢复。
