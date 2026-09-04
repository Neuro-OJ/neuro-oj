# 生产可观测性与故障 Runbook

## 观测入口

- `/healthz`：经过 Nginx 的就绪探针；返回 503 时不应继续导入流量。
- `core:8000/health/live`：进程存活检查。
- `core:8000/health/ready`：检查 PostgreSQL、Redis 与结果消费者。
- `core:8000/metrics`：Prometheus 指标端点，只应在内部网络抓取，不应映射到公网。
- 管理后台仪表盘：管理员可查看观测快照。

## Prometheus 与告警

将 Prometheus 加入 `noj-net`，使用 `deploy/monitoring/prometheus.yml` 抓取 `core:8000`，并加载 `deploy/monitoring/noj-alerts.yml`。Grafana 可导入 `deploy/monitoring/grafana-dashboard.json`。通知接收器凭据应保存在部署环境，不提交到仓库。

每次发布后应确认 Prometheus target 为 UP、live/ready/metrics 可以访问，并在 staging 演练一次 Judge 或 Redis 故障及其恢复。

## 常见故障

- Redis 或 PostgreSQL 异常：先查看 `/health/ready` 与 `noj-cli logs core`，恢复依赖后确认队列逐步回落。
- Judge 异常或队列堆积：检查 Worker 心跳、活跃任务和 `noj-cli logs judge`；不要直接删除 Redis 数据卷或队列。
- API 延迟或错误率升高：按路由与状态码查询结构化日志，区分依赖异常、慢查询和限流。
- 磁盘压力：优先暂停新评测、保留备份和日志，再扩容或按缓存策略清理；不得直接删除数据库、Redis 或对象存储卷。
