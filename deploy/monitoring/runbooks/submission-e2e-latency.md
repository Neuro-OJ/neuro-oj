# Runbook: 提交端到端延迟

## 告警含义

提交从入队到结果回传的端到端延迟超过 SLO 目标。

## 确认步骤

1. 查看 `noj_submission_e2e_duration_seconds` 分位数。
2. 检查 Judge Worker 心跳与队列积压。

## 缓解步骤

1. 若队列积压，扩容 Judge Worker 或排查卡死任务。
2. 若单题耗时异常，检查评测脚本与资源限制。

## 恢复验证

- 延迟分位数回落至目标以下。
- 告警自动恢复。
