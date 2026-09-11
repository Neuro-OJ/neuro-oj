# Runbook: 评测吞吐

## 告警含义

评测吞吐低于 SLO 目标，可能影响用户提交体验。

## 确认步骤

1. 查看 `sum(rate(noj_evaluation_results_total[5m]))` 速率。
2. 检查 Judge Worker 数量与并发上限（`noj_judge_workers`、`noj_judge_active_tasks`）。

## 缓解步骤

1. 若 Worker 不足，扩容 Judge。
2. 若存在卡死任务，清理孤儿容器并重投。

## 恢复验证

- 吞吐恢复至 0.1/s 以上。
- 告警自动恢复。

## 注意

目标 `0.1/s` 是**绝对**阈值，且 guard 只统计提交流量（`method="POST"`）：
当窗口内提交速率本身低于 0.1/s 时（低流量实例、夜间），该告警会在有提交的情况下
正常触发——这表示实例在该窗口内确实未达到目标吞吐，不是误报。若目标与实际容量不符，
应调整 `slo.ts` 中该 SLO 的 `objective`，而不是放宽 guard。
