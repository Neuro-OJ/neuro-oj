# Agent Note: 观测域收窄为纯状态上报

Status: implemented

## Problem

`domains/observability`
同时做三件事：上报自身状态（`/metrics`、`/health*`）、判定
"什么算异常"（`services/alerts.ts` 的 9 条硬编码阈值、`slo.ts` 的 SLO
目标）、以及 给人看的视图（`routes/admin.ts` 的 JSON 快照 + 管理面板卡片）。

混职责已产生实际损害：`alerts.ts` 的 `api_error_rate` 用**进程生命周期累计比例**
（`errorsTotal / requestsTotal`），而 Prometheus 告警用**滑动窗口**
`rate(noj_http_request_errors_total[5m])`。同名的"API 错误率"在两处口径不同，且
两者各自独立实现、无任何比对机制，漂移无法被发现。

管理面板的观测卡片另有一个独立问题：它已静默失效。后端在
`domains/admin/index.ts` 把观测路由挂在 `/dashboard`（实际端点
`/api/v1/admin/dashboard/observability`），而 UI 请求
`/api/v1/admin/query/dashboard/observability`。该路径差异源自计划
`2026-09-07-admin-backend-subdomain-migration.md` 的子域迁移表——UI
侧已改，后端侧 从未迁移。请求带 `{ silent: true }`，404 只使 `observability`
保持 `null`、`v-if` 不渲染，且失败提示只覆盖 `stats`，因此失效不可见。`identity`
域另有 3 条针对该不存在 路径的 RBAC
断言（401/403/200），长期断言一个不存在的路由。

## Decision

观测域只保留"采集自身状态 + 暴露为 Prometheus
文本"。判定归部署侧规则文件，展示归 Prometheus /
Grafana。判别标准：**若某个值需要先决定"这算不算正常"，它就不属于观测域。**

- 删除 `routes/admin.ts`（管理端端点）与其挂载、`services/alerts.ts`（9
  条判定）、 `write.ts` 对读侧类型的重导（写侧门面不应重导出读侧类型）。
- `types.ts` 的 `ObservabilitySnapshot` / `ObservabilityAlert` 转为内部类型
  `MetricsSnapshot`；`getObservabilitySnapshot` 改名
  `collectMetricsSnapshot`，去掉 `api` 与 `alerts` 字段，成为 `/metrics`
  的纯聚合层。
- 删除派生指标 `noj_api_error_rate_percent` 与
  `noj_api_average_latency_ms`：比率与 平均值属分析产物，Prometheus 能从原始
  counter 算出更准的版本。`noj_http_rate_limited_total` 保留——它在 `app.ts`
  被写入，属原始计数，与边界原则不冲突。
- `registry` 的 `sum()` / `count()` 随唯一调用方 `computeApiMetrics` 一起删除，
  共享契约表面积收缩。
- Grafana 看板三处表达式改用原始
  PromQL（`rate(..._errors_total[5m]) /
  rate(..._total[5m])` 与 histogram 的
  `_sum/_count`），与告警同源。
- 管理面板删除观测卡片，并顺带删掉仅服务于它的 `formatBytes()`。
- 删除 `identity` 域 3 条断言不存在路由的观测端点测试（该文件仍有 40
  条断言覆盖其他 admin 路由的 401/403/200）。

## Alternatives considered

- **只删管理面板卡片、保留 `alerts.ts` 与端点**：改动最小，但判定逻辑仍留在
  core（只是 无调用方），未达成边界目标，等于保留死代码。
- **拆成 `collect.ts` / `metrics-render.ts`
  三层、取消快照概念**：边界更干净，但要改动 `probes/registry.ts`
  与渲染函数的调用关系，且去掉中间结构会让渲染函数直接耦合各 provider
  的返回形状，改动面约翻倍而收益有限。
- **把 `slo.ts` 一并移出观测域**：`slo.ts` 是 SLO
  **定义**（数据）而非告警代码，位置确实 不当；但搬迁会连带改动
  `scripts/gen-alert-rules.ts` 的 import，与"移除告警能力"是两个
  可独立评审的议题，本次不做。
- **为已部署监控保留派生指标一个版本周期**：本变更未进
  `main`，无已部署消费者，缓冲期 无意义。
- **让 admin 通过域边界门禁禁止导入观测域读侧**：首次尝试如此实现，但 `admin`
  是聚合 门面、**不在 `check-domains.ts` 的 `DOMAINS`
  集合内**，该断言永远无法成立。遂改为对
  可测事实的断言：业务域不得导入观测域读侧深路径、写侧门面允许。

## Consequences

- 观测域表面积收缩：少两个文件、一个 HTTP 端点、两个导出类型、两个 registry
  契约方法。
- 消除一处口径漂移：`computeApiMetrics`
  的累计口径随其一起消失，看板与告警改为同源 （滑动窗口）。
- `/metrics` 与 `/health*` 的路径与语义不变；Prometheus
  抓取、`NojSloRulesMissing` 看门狗与 `gen-alert-rules --check`
  漂移检测均不受影响。
- 管理面板不再显示依赖/队列/Judge 状态卡片。这些数据在 `/metrics` 全部存在，可由
  Prometheus / Grafana 查询；面板独有的只是 9
  条硬编码判定，而它本已失效且属越界职责。
- 观测域测试改为断言 `render()` 的文本输出而非内部读数方法。这暴露了原
  `shared/observability/registry.test.ts`
  中若干断言依赖已删方法的脆弱性，改写后断言更贴近对外契约；`write.test.ts`
  也改为断言渲染文本——它原先经 `observability` 单例的 `count()` 读数（注册路径本身
  是通的，该断言有效），渲染文本断言更贴近对外契约且不依赖内部读数方法。
- `check-domains.ts` 中"观测域 index.ts 仅允许 admin
  导入"的分支被删除：它是死代码 （`sourceDomain` 不可能为
  `admin`），且其注释描述的挂载用途已不存在。
