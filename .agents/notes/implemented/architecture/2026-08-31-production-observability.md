# Agent Note: 生产可观测性与告警

Status: implemented

## Problem

生产环境原有观测能力只有综合 `/health` 和结构化日志，无法持续发现 API 错误率、依赖异常、评测队列堆积、Judge Worker 消失、结果消费者失败以及缓存/工作目录压力。管理员也缺少一个不暴露内部任务内容的运行状态视图。

## Decision

core 使用无外部运行时依赖的低基数指标注册表，提供 Prometheus 文本格式 `/metrics`，并通过请求中间件、健康检查、结果消费者和观测快照汇总 API/依赖/队列状态。新增 `/health/live` 与 `/health/ready`，保留 `/health` 的兼容语义；生产探活切换到 readiness。

Judge Worker 使用 Redis TTL 心跳 `noj:observability:judge:<instance>` 发布聚合计数、并发、容器、缓存和工作目录信息。core 通过 `SCAN` 聚合未过期心跳，管理后台只读取受 admin RBAC 保护的裁剪快照。Prometheus、Grafana、告警规则和中文 Runbook 作为部署示例提供，外部通知渠道由部署方的 Alertmanager 配置负责。

## Alternatives considered

- 引入 OpenTelemetry SDK：覆盖面更广，但会增加当前单体 core/judge 的依赖、配置和导出链路复杂度。
- 为每个 Judge 暴露独立 metrics HTTP 端口：需要额外网络暴露和服务发现，且管理后台仍需重复聚合；Redis TTL 心跳更贴合现有协作模型。
- 将历史指标写入 PostgreSQL：会把时序存储和清理职责引入业务数据库；长期历史交给 Prometheus，应用只保留进程内当前值。
- 在应用内绑定企业微信、邮件或 PagerDuty：需要保存部署方凭据并限制渠道选择，因此仅提供 Alertmanager 接入前置条件和演练 Runbook。

## Consequences

- 服务重启后进程内累计指标归零，Prometheus 负责长期保存和窗口聚合；管理后台展示的是当前进程快照。
- 多个 core 实例可由 Prometheus 按实例抓取后聚合，指标标签不使用用户、题目、提交或代码等高基数/敏感字段。
- Judge Worker 停止刷新后最多在 TTL 窗口内从在线聚合中消失；目录扫描只读取受控目录元数据，不阻断评测主流程。
- readiness 对关键依赖失败返回 503，生产负载均衡器会停止向未就绪实例导入新流量；维护和回滚仍可使用兼容的 `/health`。
