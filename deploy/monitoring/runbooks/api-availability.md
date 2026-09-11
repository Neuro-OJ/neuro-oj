# Runbook: 核心 API 可用性

## 告警含义

核心 API 5xx 错误率升高，错误预算消耗过快。

## 确认步骤

1. 打开 Grafana 平台总览，查看 `noj_http_requests_total` 与
   `noj_http_request_errors_total`。
2. 按 `route` 维度定位错误集中点。

## 缓解步骤

1. 若为单路由故障，检查对应服务/数据库/Redis 状态。
2. 若为流量突增，评估扩容或限流。

## 恢复验证

- 错误率回落至 SLO 目标以下。
- 告警自动恢复。
