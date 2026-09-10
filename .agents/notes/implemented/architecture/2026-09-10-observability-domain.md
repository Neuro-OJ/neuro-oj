# Agent Note: 可观测性平台域重构

Status: implemented

## Problem

可观测性代码散落在
`shared/base/metrics.ts`、`shared/middleware/`、`routes/health.ts`、
`domains/system/services/observability.ts` 与 admin
路由，边界不清且存在潜在循环依赖；
指标定义集中在共享文件，新增业务指标必须改共享层，缺少标签白名单与基数控制。

## Decision

在 noj-core 内建立 `domains/observability` 平台域，并配套 `shared/observability`
低层 kernel：

- 双层结构：`shared/observability` 承载
  registry/契约/日志上下文；`domains/observability`
  承载平台指标、探针、快照、健康/指标/管理路由、Judge 心跳、SLO 与运行时契约。
- 业务域只能通过 `domains/observability/write.ts` 写指标/注册 provider；观测域不
  import 任何业务域，聚合通过 `app.ts` 组合根注入 provider。
- 指标定义权混合：平台指标中央定义，业务指标各域自注册；`scripts/check-metrics.ts`
  校验命名/owner/标签。
- Fail-open 写入：所有写方法不抛错，非法标签/基数超限丢弃并记录自观测计数。
- 保留 `/health*`、`/metrics`、`/api/v1/admin/dashboard/observability`
  路径与语义。
- SLO 定义在 `domains/observability/slo.ts`，由 `scripts/gen-alert-rules.ts`
  生成/校验 `deploy/monitoring/noj-alerts.yml`。

## Alternatives considered

- 独立观测服务：运行时隔离更好，但当前单进程规模下复杂度过高。
- 端口/适配器：依赖倒置更彻底，但多一层间接，当前不必要。
- 事件驱动聚合：解耦最彻底，但需要事件基础设施，改动最大。

## Consequences

- 依赖图变为 DAG：业务域 → 观测域 → shared/observability；`check-domains.ts`
  强制边界。
- 新增指标只需在业务域注册，不再改共享层。
- 观测自身故障不会影响主链路；readiness 仍 fail-closed。
- 后续可把写侧替换为远程 sink 或独立观测服务，业务调用点不变。
