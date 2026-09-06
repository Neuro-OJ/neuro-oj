# 生产可观测性与故障 Runbook

## 观测入口

- `/healthz`：经过 Nginx 的就绪探针；返回 503 时不应继续导入流量。
- `core:8000/health/live`：进程存活检查。
- `core:8000/health/ready`：检查 PostgreSQL、Redis 与结果消费者。
- `core:8000/metrics`：Prometheus 指标端点，只应在内部网络抓取，不应映射到公网。
- 管理后台仪表盘：管理员可查看观测快照。

## Prometheus 与告警

将 Prometheus 加入 `noj-net`，使用 `deploy/monitoring/prometheus.yml` 抓取 `core:8000`（含
`up{job="noj-core"}` 失联检测），并加载 `deploy/monitoring/noj-alerts.yml`。Alertmanager 配置模板、
凭据注入与投递演练见 `deploy/monitoring/README.md`。Grafana 可导入
`deploy/monitoring/grafana-dashboard.json`。通知接收器凭据应保存在部署环境，不提交到仓库。

每次发布后应确认 Prometheus target 为 UP、live/ready/metrics 可以访问，并在 staging 演练一次 Judge
或 Redis 故障及其恢复。上线前必须执行一次告警投递演练（`scripts/deploy/test-alert.sh`）并记录结果。

## 常见故障

### Core 失联 {#core-失联}

触发：`NojCoreScrapeDown`（抓取失败）、`NojCoreMetricsMissing`（序列缺失）。

1. `noj-cli status` 与 `docker logs` 确认 core 容器状态；区分进程退出与网络/抓取配置问题。
2. 查看 `noj-cli logs core` 中的启动顺序错误（JWT_SECRET、迁移、Redis）。
3. 恢复后确认 Prometheus target UP，且 `noj_database_up`、`noj_redis_up`、
   `noj_result_consumer_up` 恢复为 1。
4. 若 core 失联期间发生评测，恢复后确认 pending 队列回落，必要时检查
   `NojQueueBacklog*` 告警是否解除。

### PostgreSQL / Redis 异常 {#postgresql-redis-异常}

触发：`NojDatabaseUnavailable`、`NojRedisUnavailable`。

1. 先查看 `/health/ready` 与 `noj-cli logs core`，确认是依赖不可达还是健康检查超时。
2. `docker compose ps` 检查 postgres/redis 容器与健康状态；查看容器日志定位 OOM/磁盘/密码问题。
3. 恢复依赖后确认队列逐步回落；Redis 数据卷损坏时使用最近快照恢复（见生产部署文档 5.1 节）。
4. 不要直接删除 Redis 数据卷或队列。

### 评测结果消费者异常 {#评测结果消费者异常}

触发：`NojResultConsumerDown`、`NojResultQueueBacklog`。

1. `noj-cli logs core` 查找结果消费者启动与写入错误；确认 PostgreSQL 可写。
2. `result processing` 积压通常是数据库写入失败重试：先恢复数据库，再观察积压回落。
3. 消费者重启后确认 `noj_result_consumer_up == 1` 且积压清零。

### Judge Worker 异常 {#judge-worker-异常}

触发：`NojJudgeWorkersDown`、`NojJudgeHeartbeatMissing`。

1. 检查 Worker 心跳、活跃任务和 `noj-cli logs judge`；确认独立 rootless Docker daemon 可用。
2. `NojJudgeHeartbeatMissing` 通常伴随 core 失联：先按 Core 失联处理。
3. 恢复后确认心跳指标恢复且队列开始消费；不要直接删除 Redis 数据卷或队列。

### 评测队列堆积 {#评测队列堆积}

触发：`NojQueueBacklogWarning`、`NojQueueBacklogCritical`。

1. 确认 Judge Worker 在线且吞吐正常（见 Judge Worker 异常）。
2. 评估是否为提交洪峰：必要时暂停新评测入口，扩容 Worker 后恢复。
3. 观察磁盘与缓存压力，避免 Worker 因资源不足批量失败。

### 评测卡死 {#评测卡死}

触发：`NojStaleJudging`。

1. 查询最早 judging 任务的入队时间与 Worker 日志，确认是否为容器泄漏或超时兜底失效。
2. 单任务卡死可由管理员 rejudge；批量卡死先停止新任务并排查沙箱 daemon。
3. 恢复后确认无新的 `NojStaleJudging` 触发。

### API 错误率或延迟升高 {#api-错误率或延迟升高}

触发：`NojApiErrorRateRecentWarning`、`NojApiErrorRateRecentCritical`（5 分钟滑动窗口 5xx 比例）、
`NojApiLatencyHigh`（P95）。

1. 按路由与状态码查询结构化日志，区分依赖异常、慢查询和限流。
2. 结合 `noj_database_up` / `noj_redis_up` 判断是否为依赖故障传导。
3. 恢复后确认 5 分钟窗口错误率回落；进程累计指标（`noj_api_error_rate_percent`）仅作长期参考。

### 磁盘和缓存压力 {#磁盘和缓存压力}

触发：`NojJudgeWorkDirPressure`、`NojHostDiskLow`。

1. 优先暂停新评测、保留备份和日志，再扩容或按缓存策略清理。
2. 不得直接删除数据库、Redis 或对象存储卷。
3. 处理后确认 `node_filesystem_avail_bytes` 比例回升。

### 备份过期 {#备份过期}

触发：`NojBackupStale`（>25h）、`NojBackupVeryStale`（>49h）、`NojBackupMetricMissing`。

1. 检查备份 cron 是否运行、`backup.sh create` 最近输出与退出码。
2. 确认 textfile 目录（`<备份目录>/metrics/noj_backup.prom`）在最近一次备份后有更新；
   `NojBackupMetricMissing` 通常说明 node_exporter textfile collector 未配置（见
   `deploy/monitoring/README.md` 第 2 节）。
3. 备份长时间未成功期间发生的故障无法回滚，尽快手动执行一次备份并验证。

### 恢复演练过期 {#恢复演练过期}

触发：`NojRestoreDrillStale`（>90 天未演练）。

1. 文件校验不能证明业务可恢复；安排执行 `scripts/deploy/restore-drill.sh`（见生产部署文档 5.1 节）。
2. 演练完成后确认 textfile 目录中 `noj_restore_drill.prom` 更新，告警在下一个评估周期解除。
