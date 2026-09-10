# Runbook: 结果回传延迟

## 告警含义

评测结果从 Judge 回传到 core 的延迟超过 SLO 目标。

## 确认步骤

1. 查看 `noj_result_delivery_duration_seconds`。
2. 检查 Redis 结果队列长度与消费者状态。

## 缓解步骤

1. 若结果队列积压，检查 noj-core 结果消费者。
2. 若 Redis 异常，恢复 Redis 连接。

## 恢复验证

- 回传延迟回落。
- 告警自动恢复。
