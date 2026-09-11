# 收窄观测域职责为纯状态上报 — 设计

Status: proposed

## 背景

`domains/observability` 当前同时承担三件事：

1. **上报状态**：把自身状态暴露为 Prometheus
   文本（`/metrics`）与健康探针（`/health*`）。
2. **判定"什么算异常"**：`services/alerts.ts` 用 9
   条硬编码阈值判断平台健康；`slo.ts` 定义 SLO 目标与燃烧率公式。
3. **给人看的视图**：`routes/admin.ts` 暴露管理端 JSON 快照，由管理面板渲染。

三件事混在一处已产生可观测的实际损害：`alerts.ts` 的 `api_error_rate`
用**进程生命周期累计比例** （`errorsTotal / requestsTotal`），而 Prometheus
告警用**滑动窗口** `rate(noj_http_request_errors_total[5m])`。 同一个"API
错误率"概念在两处口径不同，且没有任何机制能发现这种漂移——因为两处是各自独立实现的。

本设计把观测域收窄为只做第 1 件事。第 2 件归部署配置（Prometheus 规则文件），第
3 件归外部平台 （Prometheus / Grafana）。

## 目标与非目标

**目标**

- 观测域只负责"采集自身状态 + 暴露为 Prometheus 文本"。
- core 不再计算派生判断值（比率、平均值、健康结论）。
- 移除管理端观测入口与其 API 端点。

**非目标**

- 不改动 `/metrics`、`/health`、`/health/live`、`/health/ready` 的路径与语义。
- 不删除任何**原始**指标（counter / histogram / gauge）。
- 不搬迁 `slo.ts` 与 `scripts/gen-alert-rules.ts`（见"已排除的替代方案"）。

## 当前状态与既有缺陷

管理面板的观测卡片**已失效**，原因是一次未完成的迁移：

- 后端在 `domains/admin/index.ts:53` 把观测路由挂在 `/dashboard`，其内部为
  `router.get("/observability")`，即实际端点是
  `/api/v1/admin/dashboard/observability`。
- UI 在 `noj-ui/pages/admin/index.vue:112` 请求
  `/api/v1/admin/query/dashboard/observability`。
- `domains/admin/routes/query.ts` 只注册了
  `/dashboard/stats`，因此该请求落到不存在的路由。
- 请求带 `{ silent: true }`，404 只使 `observability` 保持 `null`，`v-if`
  不渲染；且 `index.vue:127` 的失败提示只覆盖
  `stats`，观测卡片加载失败**不产生任何提示**。

该路径改动源自
`dev-docs/superpowers/plans/2026-09-07-admin-backend-subdomain-migration.md:305`
的计划迁移表（`/dashboard/observability` →
`/query/dashboard/observability`）：UI 侧已改，
后端侧从未迁移。后果是后端端点无调用方，且
`identity/tests/routes/auth-admin.test.ts` 有三条针对
`/query/dashboard/observability` 的权限断言（401/403/200）实际断言的是一个
不存在的路由。

因此本次改动同时清理一个死端点、一个失效窗口与两组断言不存在路由的测试。

## 决定

### 1. 边界

`noj-core` 的观测域只做"采集自身状态并暴露为 Prometheus
文本"。判定归部署侧的规则文件， 展示归 Prometheus /
Grafana。判别标准：**若某个值需要 core
先决定"这算不算正常"，它就不属于观测域。**

### 2. 删除物

| 位置                                                | 内容                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `domains/observability/routes/admin.ts`             | 整个文件                                                                |
| `domains/observability/services/alerts.ts`          | 整个文件（9 条阈值判定）                                                |
| `domains/observability/index.ts`                    | `createObservabilityAdminRouter` 导出                                   |
| `domains/admin/index.ts`                            | `/dashboard` 挂载及其 import                                            |
| `domains/observability/types.ts`                    | `ObservabilityAlert`、`ObservabilitySnapshot`、`api` 字段               |
| `domains/observability/services/snapshot.ts`        | `computeApiMetrics()`、`ApiView`、`alerts` 字段                         |
| `shared/observability/contracts.ts` + `registry.ts` | `sum()` / `count()` 的契约声明（`contracts.ts`）与实现（`registry.ts`） |
| `noj-ui/pages/admin/index.vue`                      | 观测卡片模板、两个 ref、观测请求、相关类型                              |
| `deploy/monitoring/grafana-dashboard.json`          | 三个使用派生指标的 `expr` 改为原始表达式                                |

### 3. 保留物

- `routes/health.ts`、`/metrics`、`renderPrometheusMetrics`、`middleware/http-metrics.ts`、
  `middleware/request-context.ts`。
- `probes/registry.ts`、`services/judge-heartbeat.ts`、`services/snapshot.ts`（改名后）、
  `metrics/platform.ts`、`metrics/business-catalog.ts`、`write.ts`。
- **所有原始指标**，包括 `noj_http_rate_limited_total`。它在 `app.ts`
  中被写入，属原始计数，
  按边界原则应继续上报；当前无用例是"没人查"而非"不该报"，删除属独立议题。
- `slo.ts` 与 `scripts/gen-alert-rules.ts`（见下）。

### 4. 数据流

改动前，两处各自调用同一聚合函数，其中之一附带判定：

```text
runHealthProbes + collectSnapshot
        ↓
getObservabilitySnapshot()        ← 内含 makeAlerts() 判定
        ├─→ admin API JSON        （对外契约）
        └─→ renderPrometheusMetrics → registry.set(...) → /metrics
```

改动后单出口、无判定：

```text
runHealthProbes + collectSnapshot
        ↓
collectMetricsSnapshot()          ← 纯数据聚合，无 alerts、无派生比率
        ↓
renderPrometheusMetrics → registry.set(...) → /metrics → Prometheus
```

`collectMetricsSnapshot` 保留中间结构：探针结果与 provider
结果需要在此合并，去掉它会让渲染 函数直接依赖各 provider
的返回形状，耦合反而更深。

### 5. 契约变化

| 契约                                                | 变化                                                         | 影响面                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `GET /api/v1/admin/dashboard/observability`         | 删除                                                         | 无调用方（UI 已在请求不存在的 `/query/...`）                                         |
| `ObservabilitySnapshot` / `ObservabilityAlert` 类型 | 删除，改为内部类型 `MetricsSnapshot`                         | 仅经 `index.ts` 导出，无外部消费                                                     |
| `getObservabilitySnapshot()`                        | 改名 `collectMetricsSnapshot()`，去掉 `api` 与 `alerts` 字段 | 仅 `snapshot.ts` 内部与域测试引用                                                    |
| `api.error_rate_percent` / `api.average_latency_ms` | 删除                                                         | Grafana 看板同步改表达式                                                             |
| `noj_api_error_rate_percent`                        | 删除                                                         | 看板改 `rate(noj_http_request_errors_total[5m]) / rate(noj_http_requests_total[5m])` |
| `noj_api_average_latency_ms`                        | 删除                                                         | 看板改 histogram 的 `_sum / _count` 表达式                                           |
| `registry.sum()` / `count()`                        | 删除                                                         | 删派生逻辑后无调用方                                                                 |

本变更尚未进入 `main`，因此上述删除不构成对已部署监控的破坏性变更，无需过渡期。

### 6. 测试影响

- 删除 `domains/observability/tests/admin.test.ts`（16
  行）、`tests/alerts.test.ts`（51 行）。
- 修改 `tests/snapshot.test.ts`：移除 `alerts` 相关断言，保留"provider
  失败降级为部分快照"与 "`/metrics` 无重复 HELP"两条行为断言。
- 删除 `identity/tests/routes/auth-admin.test.ts`
  中三条观测端点断言（它们断言的路由不存在）。 该文件共 46 条断言，覆盖 users /
  problems / submissions 等多条 admin 路由的 401/403/200，
  权限覆盖不因删除这三条而下降——RBAC 守卫挂在 admin
  路由组层，本设计不触及其装配。
- 修改 `scripts/check-domains_test.ts`：移除"admin import observability/index.ts
  允许"与 "observability 域内 import `getObservabilitySnapshot`"两个
  fixture，并新增反向 fixture 断言 admin **不再**从观测域 import 读侧。

## 已排除的替代方案

- **只删管理面板卡片、保留 `alerts.ts` 与端点**：改动最小，但判定逻辑仍留在
  core（只是无调用方）， 未达成收窄目标，等于保留死代码。
- **拆成 `collect.ts` / `metrics-render.ts`
  三层、取消快照概念**：边界更干净，但要改动 `probes/registry.ts`
  与渲染函数的调用关系，且去掉中间结构会让渲染函数耦合各 provider 的
  返回形状。改动面约翻倍而收益有限。
- **把 `slo.ts` 一并移出观测域**：`slo.ts` 是 SLO
  **定义**（数据），不是告警代码，位置确实不当； 但搬迁会连带改动
  `scripts/gen-alert-rules.ts` 的 import 与域边界测试。它与"移除告警能力"
  是两个可独立评审的议题，本次不做。
- **为已部署监控保留派生指标一个版本周期**：本变更未进
  `main`，无已部署消费者，缓冲期无意义。
- **保留 `noj_http_rate_limited_total`
  之外的派生值**：按"需要先判定正常与否"的标准，比率与
  平均延迟都属分析产物，Prometheus 能从原始 counter 算出更准的版本。

## 影响

- 观测域表面积收缩：减少两个文件、一个 HTTP 端点、两个导出类型、两个 registry
  契约方法。
- 消除一处口径漂移：`api_error_rate` 的累计口径随 `computeApiMetrics`
  一并消失，看板改为与 告警同源（滑动窗口）。
- 管理面板不再显示依赖/队列/Judge 状态卡片。这些数据在 `/metrics`
  全部存在，Prometheus 与 Grafana 可查；面板的唯一独有能力是 9
  条硬编码判定，而它已失效且属越界职责。
- `/metrics` 与 `/health*` 的契约与语义不变，Prometheus 抓取与告警规则不受影响。
  `NojSloRulesMissing` 看门狗与 `gen-alert-rules --check` 漂移检测能力保留。

## 开放问题

- `identity/tests/routes/auth-admin.test.ts` 的三条断言按本设计删除。若 admin
  域重组的后续计划 仍希望把观测端点迁到 `/query/`
  下，应由该计划显式提出，而不是让一组针对不存在路由的断言长期存在。
- `dev-docs/superpowers/specs/2026-09-10-observability-domain-design.md` 与对应
  plan 描述了
  扩张版观测域（含告警与管理端点）。它们是历史计划记录，不在本次回改范围；当前代码以本设计为准。
