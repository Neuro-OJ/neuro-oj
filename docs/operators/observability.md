# 生产可观测性与故障 Runbook

## 观测入口

- `/healthz`：经过 Nginx 的 readiness 探针。HTTP 200 表示 core 及其关键依赖可接收流量；HTTP 503 表示不应继续导入流量。
- `core:8000/health/live`：只表示进程仍能处理 HTTP 请求，不检查 PostgreSQL、Redis 或 Judge。
- `core:8000/health/ready`：检查 PostgreSQL、Redis 和结果消费者。
- `core:8000/metrics`：Prometheus 文本指标，仅应在内部网络抓取，不要将 core 端口直接映射到公网。
- 管理后台首页：展示经过管理员权限保护的观测快照，默认按页面刷新设置轮询。

## 接入 Prometheus、Grafana 和 Alertmanager

1. 将 Prometheus 加入 `noj-net`，复制 `deploy/monitoring/prometheus.yml`，确认目标为 `core:8000`。
2. 将 `deploy/monitoring/noj-alerts.yml` 放入规则目录，并执行 Prometheus 配置检查与 reload。
3. 导入 `deploy/monitoring/grafana-dashboard.json`，选择对应 Prometheus datasource。
4. 为 Alertmanager 配置实际通知接收器。仓库不保存通知凭据，也不限定企业微信、邮件或 PagerDuty 等渠道。
5. 若需要宿主机磁盘告警，额外部署 node_exporter，并取消 Prometheus 配置中的 node target 注释；不应把 Judge 工作目录占用误认为宿主机剩余空间。

日志聚合和保留：生产 Compose 默认使用 Docker `json-file` 日志驱动，每个容器单文件最多 50 MiB、保留 5 个文件。需要集中检索时，在宿主机或日志平台配置 Docker logging driver/采集器，将 core、judge、nginx 和 llm-gateway 的 JSON 结构化日志发送到 Loki、Elasticsearch 或现有日志平台；不要把凭据、代码、prompt 或完整提交内容写入日志。日志轮转上限只是本地兜底，集中平台的保留期限和访问权限仍需单独配置。

推荐检查：

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec core \
  wget -qO- http://127.0.0.1:8000/health/live
docker compose --env-file .env.prod -f docker-compose.prod.yml exec core \
  wget -qO- http://127.0.0.1:8000/health/ready
docker compose --env-file .env.prod -f docker-compose.prod.yml exec core \
  wget -qO- http://127.0.0.1:8000/metrics | head
```

## PostgreSQL/Redis 异常

1. 查看 `/health/ready` 返回的组件状态和 `docker compose ps`。
2. 检查 `docker compose logs --tail=200 postgres redis core`，确认是服务停止、认证失败还是连接耗尽。
3. PostgreSQL 恢复后确认 ready 变为 200；Redis 恢复后确认 `noj_redis_up=1`，再观察 pending/processing 队列是否下降。
4. 若 Redis 长时间不可用，暂停高频提交入口并保留数据卷；不要删除 Redis 卷作为第一处置动作。

## Judge Worker 异常

1. 检查 `noj_judge_workers`、`noj_judge_active_tasks` 和 `noj_judge_orphan_containers`。
2. 查看 `docker compose logs --tail=200 judge`，确认独立 Docker socket、Redis、镜像和权限。
3. 重启 Judge 后等待最多 30 秒，确认 TTL 心跳重新出现、pending 队列开始下降。
4. 若存在孤儿容器或工作目录持续增长，先停止异常 Worker，再按任务/缓存清理策略处理；保留日志和告警时间点供复盘。

## 评测队列堆积

1. 对比 `noj_queue_pending_jobs`、`noj_queue_processing_jobs`、`noj_judge_active_tasks` 和 `noj_queue_judging_jobs`。
2. pending 高且 active 为 0：优先处理 Judge Worker 异常。
3. processing 高且 active 低：检查 Worker 重启、Redis processing 列表和 sweeper 重投日志。
4. active 达到并发上限且任务正常完成：按容量模型扩容 Worker；不要直接删除队列。
5. 结果 processing 高：检查 PostgreSQL 写入错误和 core 结果消费者，确认恢复后消息会被重投并幂等处理。

## 评测卡死

1. 查看 `noj_queue_oldest_judging_age_seconds` 和最近评测日志。
2. 确认 Judge 心跳仍在线；检查容器创建、双容器协议、超时和 Docker daemon 日志。
3. 先按现有优雅重启流程排空 Worker；必要时仅重启 Judge，不删除 PostgreSQL/Redis/对象存储数据卷。
4. 恢复后确认新的提交可完成、旧 processing 任务由 sweeper 重投或明确进入错误状态。

## API 错误率或延迟升高

1. 查看 `noj_api_error_rate_percent`、`noj_api_average_latency_ms`，再按 route/status 查询结构化日志。
2. 区分依赖故障、数据库慢查询、Redis 限流和单一路由异常；不要只依据累计进程指标判断短时波动。
3. 必要时启用维护模式或临时收紧入口限流，恢复依赖后确认 `/healthz` 和核心业务请求均正常。

## 磁盘和缓存压力

- `noj_judge_cache_bytes` 和 `noj_judge_work_dir_bytes` 反映 Judge 容器内可见目录占用，不等于宿主机剩余空间。
- 宿主机剩余空间使用 node_exporter 的 `node_filesystem_avail_bytes` 规则；同时检查 Docker daemon 所在磁盘。
- 缓存由 Judge 的最大条目数/最大字节数控制；清理前先确认没有正在使用的临时目录，保留最近故障现场。
- 磁盘不足时优先暂停新评测、保留备份和日志，再扩容或清理；禁止直接删除数据库、Redis 或对象存储卷。

## 告警演练记录

每次发布或首次上线完成以下检查并记录时间、操作者、结果和恢复动作：

1. Prometheus target 为 UP，规则文件加载成功。
2. Alertmanager receiver 配置有效，可收到一条测试通知。
3. 访问 live/ready/metrics，确认状态和指标可解析。
4. 在 staging 暂停 Judge 或阻断 Redis，确认对应告警触发。
5. 恢复服务，确认 ready、心跳和队列回落，告警自动恢复。
