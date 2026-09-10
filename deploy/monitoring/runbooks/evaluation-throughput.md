# Runbook: 评测吞吐

## 告警含义

评测吞吐低于 SLO 目标，可能影响用户提交体验。

## 确认步骤

1. 查看 `noj_evaluation_throughput_total` 速率。
2. 检查 Judge Worker 数量与并发上限。

## 缓解步骤

1. 若 Worker 不足，扩容 Judge。
2. 若存在卡死任务，清理孤儿容器并重投。

## 恢复验证

- 吞吐恢复至目标以上。
- 告警自动恢复。
