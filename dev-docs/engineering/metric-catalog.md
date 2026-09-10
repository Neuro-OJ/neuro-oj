# 指标 Catalog

> 由 `scripts/check-metrics.ts` 校验；平台指标定义在
> `noj-core/src/domains/observability/metrics/platform.ts`，业务指标由各域通过
> `domains/observability/write.ts` 注册。

## 命名规则

- 平台/基础设施：`noj_<area>_<metric>_<unit>`
- 业务：`noj_<domain>_<metric>_<unit>`
- 自观测：`noj_observability_<metric>_<unit>`

## 标签白名单

`method`、`route`、`status`、`queue`、`provider`、`language`、`result`、`type`、`criticality`、`message_type`、`event_type`、`reason`

禁止标签：`user_id`、`submission_id`、`problem_id`、`request_id`、`trace_id`、`contest_id`
等动态 ID。

## 平台指标（节选）

| 指标                                   | 类型      | 说明                          |
| -------------------------------------- | --------- | ----------------------------- |
| `noj_http_requests_total`              | counter   | HTTP 请求总数                 |
| `noj_http_request_errors_total`        | counter   | HTTP 5xx 请求总数             |
| `noj_http_rate_limited_total`          | counter   | HTTP 被限流请求总数           |
| `noj_http_request_duration_seconds`    | histogram | HTTP 请求耗时                 |
| `noj_http_requests_in_flight`          | gauge     | 当前处理中的 HTTP 请求数      |
| `noj_http_sse_connections`             | gauge     | 当前 SSE 连接数               |
| `noj_database_up`                      | gauge     | PostgreSQL 是否可用           |
| `noj_redis_up`                         | gauge     | Redis 是否可用                |
| `noj_queue_pending_jobs`               | gauge     | 评测 pending 队列长度         |
| `noj_queue_processing_jobs`            | gauge     | 评测 processing 队列长度      |
| `noj_queue_result_pending_jobs`        | gauge     | 评测结果 pending 队列长度     |
| `noj_queue_result_processing_jobs`     | gauge     | 评测结果 processing 队列长度  |
| `noj_queue_judging_jobs`               | gauge     | 数据库中 judging 状态的评测数 |
| `noj_queue_oldest_judging_age_seconds` | gauge     | 最早 judging 评测年龄         |
| `noj_judge_workers`                    | gauge     | 在线 Judge Worker 数          |
| `noj_judge_active_tasks`               | gauge     | Judge 活跃任务数              |
| `noj_judge_orphan_containers`          | gauge     | Judge 孤儿容器数              |
| `noj_judge_cache_items`                | gauge     | Judge 支持包缓存条目数        |
| `noj_judge_cache_bytes`                | gauge     | Judge 支持包缓存字节数        |
| `noj_judge_work_dir_bytes`             | gauge     | Judge 工作目录字节数          |
| `noj_judge_completed_tasks_total`      | gauge     | Judge 累计完成任务数           |
| `noj_judge_failed_tasks_total`         | gauge     | Judge 累计失败任务数           |
| `noj_judge_result_push_failures_total` | gauge     | Judge 累计结果回传失败数       |
| `noj_api_error_rate_percent`           | gauge     | API 5xx 错误率百分比          |
| `noj_api_average_latency_ms`           | gauge     | API 平均延迟                  |

## 业务指标（示例）

| 指标                                   | 类型      | 说明                   | 域         |
| -------------------------------------- | --------- | ---------------------- | ---------- |
| `noj_submission_e2e_duration_seconds`  | histogram | 提交端到端耗时         | submission |
| `noj_evaluation_results_total`         | counter   | 收到的评测结果总数     | submission |
| `noj_evaluation_consumer_errors_total` | counter   | 评测结果消费者错误总数 | submission |
| `noj_email_send_attempts_total`        | counter   | 邮件发送尝试总数       | system     |
| `noj_email_delivery_events_total`      | counter   | 邮件送达事件总数       | system     |

## 自观测指标

| 指标                                     | 说明                           |
| ---------------------------------------- | ------------------------------ |
| `noj_observability_write_errors_total`   | 观测写错误总数                 |
| `noj_observability_metric_dropped_total` | 观测指标丢弃总数（基数超限等） |
