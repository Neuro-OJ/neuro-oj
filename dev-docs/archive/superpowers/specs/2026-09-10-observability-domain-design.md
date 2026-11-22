# 可观测性平台域（Observability Domain）设计

- Status: proposed
- Date: 2026-09-10
- Scope: noj-core 进程内架构重构；外部运行时接入契约；指标扩充与 SLO 单一事实源
- Related: `openspec/changes/production-observability/`、`scripts/check-domains.ts`、
  `dev-docs/engineering/domain-boundaries.md`

## 1. 背景

`production-observability` 变更已经交付了可用的最小观测闭环：

- `noj-core` 提供 Prometheus 文本格式的 `/metrics`，覆盖 HTTP 请求、数据库/Redis 健康、评测队列、结果消费者和 Judge 心跳聚合。
- `/health`、`/health/live`、`/health/ready` 已拆分，readiness 在依赖未就绪时返回 503。
- 管理员观测快照 API `/api/v1/admin/dashboard/observability` 提供依赖、队列、API、Judge 和告警聚合。
- 仓库提供 Prometheus 抓取配置、Grafana dashboard、Alertmanager 模板、告警规则和中文 Runbook。
- `noj-cli` 提供 `status`、`logs`、`backup`、`restore`、`drill`、`update`、`uninstall` 等运维命令。

但代码层面的可观测性仍然分散：

| 现状位置 | 职责 |
|---|---|
| `noj-core/src/shared/base/metrics.ts` | 指标注册表与全部指标定义 |
| `noj-core/src/shared/middleware/metrics.ts` | HTTP 指标中间件 |
| `noj-core/src/routes/health.ts` | 健康探针（在 domain 体系之外） |
| `noj-core/src/domains/system/services/observability.ts` | 快照聚合、Prometheus 渲染、Judge 心跳读取 |
| `noj-core/src/domains/admin/routes/query.ts` | 管理员观测路由 |
| 各业务域与 `shared/**` | 直接调用 `metrics.inc(...)` |

这带来四个长期问题：

1. **边界不清**：可观测性既像 shared 基础设施，又像 system 域的一部分，还散落在 admin 路由。
2. **潜在循环**：若把写侧收进新 domain，业务域依赖观测域写侧，而观测域快照又直接 import 业务服务，会形成 `业务域 ↔ 观测域` 环。
3. **写侧约束不足**：指标定义集中在 `shared/base/metrics.ts`，新增业务指标必须改这个共享文件；同时缺少标签白名单、基数上限和 owner 校验。
4. **观测自身不可观测**：快照聚合、探针、provider 的失败没有自观测指标，故障时难以判断是业务坏了还是观测坏了。

本设计的目标是：在 noj-core 内把可观测性抽离为一个**进程内平台域**，建立**无环依赖**、**Fail-open 写入**、**单向依赖 + CI 强制**的长期架构，并在此基础上扩充五类指标与 SLO 单一事实源。

## 2. 目标与非目标

### 2.1 目标

- 在 `noj-core` 内建立 `domains/observability` 平台域，统一拥有平台指标定义、健康探针、快照聚合、Judge 心跳协议、管理员观测 API、SLO 定义与部署资产校验。
- 建立 `shared/observability` 低层 kernel，承载指标注册表、写侧契约和日志上下文，保持 `shared/**` 不反向依赖 `domains/**` 的现有不变量。
- 业务域只能通过 `domains/observability/write.ts` 写入指标、注册健康探针和快照 provider；观测域不 import 任何业务域。
- 所有指标写入、探针执行、快照聚合对主链路 Fail-open；观测故障不得导致业务请求 500 或进程崩溃。
- 通过 CI 静态检查强制依赖方向、指标命名/标签/owner 和外部运行时契约。
- 扩充五类指标：HTTP/平台、基础设施/资源、Judge 细粒度、LLM 网关、业务 SLI。
- 建立 SLO 单一事实源，生成/校验 Prometheus 告警规则，并让每条告警绑定 Runbook。
- 保留现有对外路径与语义：`/metrics`、`/health`、`/health/live`、`/health/ready`、`/api/v1/admin/dashboard/observability`。

### 2.2 非目标

- 不引入 OpenTelemetry SDK 或分布式追踪后端；本期只预留 `trace_id` 上下文位置。
- 不建设日志聚合平台（Loki/ELK）；本期只收敛日志上下文与结构化字段。
- 不新增独立进程/容器；本期是 noj-core 进程内重构，写侧契约设计为未来可外迁。
- 不做多实例 core 的指标聚合改造；指标仍按实例暴露，由 Prometheus 聚合。
- 不改变 Judge 心跳的 Redis key、TTL 和刷新周期；只收敛 core 侧读取逻辑并增加协议版本字段。
- 不在本期实现前端 RUM。
- 不引入新的运行时依赖。

## 3. 关键决策

### D1：进程内平台域，而非独立服务

选择在 noj-core 进程内建立 `domains/observability`。理由：

- 当前是单进程部署，观测数据源（DB、Redis、队列、消费者）都在 core 进程内或可通过 shared 访问。
- 进程内 domain 可以用最小改动建立清晰边界；独立服务会引入网络跳转、服务发现、部署编排和额外的故障面。
- 写侧契约面向接口设计，未来若要外迁为独立观测服务，业务调用点不变。

备选：独立 `noj-observability` 服务。优点是运行时隔离；缺点是当前规模下复杂度过高，且会让单进程部署变成多组件编排。暂不采用。

### D2：双层结构——shared kernel + observability domain

现有架构硬性规定 `shared/**` 不得反向依赖 `domains/**`（`scripts/check-domains.ts` 的 `checkSharedImports`）。但 `shared/db/connection.ts`、`shared/mq/connection.ts` 需要写指标。如果观测域完全拥有写侧 registry，就会产生 `shared → domains/observability` 的反向依赖。

因此采用双层：

- `shared/observability/`：低层 kernel，零业务依赖。包含指标注册表、写侧契约、日志上下文。`shared/**` 和所有 domain 都可以依赖它。
- `domains/observability/`：平台域。包含平台指标定义、探针注册表、快照聚合、健康/指标/管理路由、Judge 心跳协议、SLO 定义、外部运行时契约和部署资产校验。它只依赖 `shared/observability` 与 `shared/**`，不依赖任何业务域。

业务域通过 `domains/observability/write.ts` 使用观测能力；`shared/**` 直接依赖 `shared/observability/**`。这样保持 `shared` 不依赖 `domains` 的现有不变量，同时把“观测域”作为平台域对外提供稳定入口。

备选一：单层 domain + 允许 `shared → domains/observability` 例外。会破坏现有不变量，且例外会长期存在。
备选二：`shared` 不再直接写指标，DB/MQ 健康改为 provider/事件。依赖最干净，但 shared 需要新增回调机制，改动更大，且 DB/MQ 健康探针本质仍属于基础设施自观测。

### D3：Provider 注册打破聚合循环

如果业务域 import 观测域写侧，而观测域快照直接 import 业务服务聚合，会形成 `业务域 ↔ 观测域` 环。因此规定：

- 观测域**不 import 任何业务域**。
- 业务域导出 `register<Domain>Observability(registry)` 函数，由 `app.ts` 组合根调用。
- 业务域通过 `SnapshotProvider` 把队列、消费者、judging 统计等状态贡献给观测域。
- `app.ts` 是唯一组合根：同时 import 业务域门面和观测域，负责把 provider 注入观测域。

依赖图因此是 DAG：`业务域 → 观测域 → shared/observability`，组合根在两端之上。

### D4：一次性重构，不留兼容层

采用一次性重构：所有 import、路由、调用点在同一变更集内迁移到新结构，不保留 `shared/base/metrics.ts` 旧入口，不做双写。

风险集中，因此用以下手段对冲：

- 保留对外 HTTP 路径与响应语义，加路由契约测试。
- 每完成一个阶段都保证 `deno check` 全绿。
- 用 CI 边界检查、指标 catalog 检查和跨模块 E2E 作为验收门禁。
- 没有数据库迁移；回滚 = revert 变更集或回退镜像。

### D5：混合指标定义权

- **平台/基础设施指标**由观测域中央定义：HTTP、DB、Redis、队列、Judge 心跳、进程资源。
- **业务指标**由各业务域通过 `registerBusinessMetric` 自注册：提交、评测、竞赛、社区、网关等。
- **自观测指标**由 kernel 固定定义：写失败、标签非法、基数溢出、provider 超时等。
- CI 通过 `scripts/check-metrics.ts` 扫描注册调用，校验命名、owner、标签白名单和低基数。

这样既避免“每加一个业务指标都改观测域”，又避免“各域随意命名导致 catalog 失控”。

### D6：Fail-open 写入，Fail-closed readiness

- **写入/聚合 Fail-open**：指标写入、探针执行、provider 聚合、`/metrics` 渲染中的任何异常都不得冒泡到业务请求；观测自身降级为 `unknown` 或空数据。
- **readiness Fail-closed**：`/health/ready` 要求所有 critical 探针为 `up`；`unknown`（超时/异常）和 `down` 都返回 503，避免把不可靠实例继续挂到负载均衡后面。
- `/health/live` 永远不检查外部依赖，永远 200。

这两个语义必须区分：Fail-open 保护的是进程和主链路，不是“把不健康实例当作健康”。

### D7：外部运行时指标由 Prometheus 直抓

- `noj-llm-gateway` 新增内部 `/health/live`、`/health/ready`、`/metrics`，由 Prometheus 直接抓取。
- `noj-judge` 本期保留 Redis TTL 心跳，契约预留 `mode: "http"`，未来可加 `/metrics`。
- core 只负责健康状态聚合（`runtimes` section），不代理 gateway/judge 的指标数据，避免 core 成为观测瓶颈。
- 所有 `/metrics`、`/health/*` 只绑定内部网络，不映射公网。

### D8：SLO 与告警规则单一事实源

- `domains/observability/slo.ts` 集中定义 SLI、目标、窗口、burn-rate 窗口和 Runbook 路径。
- `scripts/gen-alert-rules.ts` 从 SLO 定义生成或校验 `deploy/monitoring/noj-alerts.yml`。
- `scripts/check-runbooks.ts` 校验每条告警的 Runbook 链接可解析。
- 避免“应用内 SLO 定义”和“Prometheus 告警规则”两处维护导致漂移。

### D9：保留对外路径与语义

即使本期验收标准未把“对外契约兼容”列为硬性要求，仍保留以下路径与语义，避免破坏现有 Prometheus/Nginx/UI 配置：

- `/metrics`：Prometheus 0.0.4 文本格式。
- `/health`：始终 200，`healthy`/`degraded`。
- `/health/live`：进程存活。
- `/health/ready`：依赖就绪时 200，否则 503。
- `/api/v1/admin/dashboard/observability`：管理员 RBAC 保护下的 JSON 快照。

响应体只做增量字段（例如 `providers[]`），不删除现有字段。

## 4. 架构与依赖边界

### 4.1 分层图

```text
                    ┌──────────────────────────────┐
                    │ app.ts（组合根）              │
                    │ 注册 providers / 挂载路由      │
                    └──────────┬───────────────────┘
                               │ 只在这里组装
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌───────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ domains/          │  │ domains/<业务域>  │  │ domains/admin    │
│ observability     │  │ 提交/竞赛/网关... │  │ 管理门面          │
│ 平台域            │  │                  │  │                  │
│ 平台指标定义      │  │ 业务指标自注册    │  │ 挂载观测管理路由  │
│ 探针/快照/SLO     │  │ 导出 snapshot     │  │                  │
│ 健康/指标/管理路由│  │ provider          │  │                  │
└─────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
          │                     │                     │
          │ 只允许依赖           │ 只允许依赖           │
          ▼                     ▼                     ▼
┌───────────────────────────────────────────────────────────────┐
│ shared/observability/（kernel：零业务依赖，fail-open）          │
│  - registry（counter/gauge/histogram）                         │
│  - 写侧契约：MetricSink / HealthProbe / SnapshotProvider       │
│  - 日志上下文（request_id / 预留 trace_id）                     │
└───────────────────────────────┬───────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────┐
│ shared/db、shared/mq、shared/http、shared/base ...              │
└───────────────────────────────────────────────────────────────┘
```

### 4.2 依赖规则

1. `shared/**` 只能依赖 `shared/observability/**`，**不得**依赖任何 `domains/**`（保持现有不变量）。
2. 业务域只能依赖 `shared/observability/**` 与 `domains/observability/write.ts`；**禁止**深路径 import 观测域的 `services/`、`routes/`、`metrics/`。唯一例外是 `domains/admin` 可以 import `domains/observability/index.ts` 以挂载观测管理路由（见规则 6）。
3. `domains/observability` **不得 import 任何其他业务域**（这是打破循环的关键）。
4. 观测域需要的业务状态通过 `SnapshotProvider` 获取；provider 由业务域导出、由 `app.ts` 组合根注册。
5. `app.ts` 是唯一组合根：import 各业务域门面和观测域，注册 provider，挂载路由。
6. `domains/admin` 可以 import `domains/observability/index.ts` 以挂载观测管理路由；观测域不反向 import admin。该例外仅用于路由挂载，不用于访问观测域内部实现。

### 4.3 目标目录结构

```text
noj-core/src/
├── shared/
│   └── observability/                    # 低层 kernel，零业务依赖
│       ├── contracts.ts                  # MetricSink / HealthProbe / SnapshotProvider
│       ├── registry.ts                   # MetricsRegistry 实现（fail-open）
│       ├── labels.ts                     # 标签校验、低基数规则
│       ├── context.ts                    # request_id / trace_id 上下文
│       └── index.ts                      # kernel 公共入口
├── domains/
│   └── observability/                    # 平台域
│       ├── index.ts                      # 域门面（路由装配 + 只读 API）
│       ├── write.ts                      # 业务域唯一允许 import 的写侧门面
│       ├── types.ts                      # ObservabilitySnapshot 等读侧类型
│       ├── metrics/
│       │   ├── platform.ts               # 平台/基础设施指标定义
│       │   ├── business-catalog.ts       # 业务指标注册与校验
│       │   └── sli.ts                    # SLI/SLO 定义
│       ├── probes/
│       │   ├── registry.ts               # 探针/provider 注册表
│       │   └── builtin.ts                # 平台内置探针
│       ├── middleware/
│       │   ├── http-metrics.ts           # HTTP 指标中间件
│       │   └── request-context.ts        # request_id / trace_id 中间件
│       ├── routes/
│       │   ├── health.ts                 # /health、/health/live、/health/ready
│       │   ├── metrics.ts                # /metrics
│       │   └── admin.ts                  # 管理员观测 API router
│       ├── services/
│       │   ├── snapshot.ts               # 快照聚合（遍历 provider）
│       │   ├── judge-heartbeat.ts        # Judge TTL 心跳协议与聚合
│       │   ├── runtime-contract.ts       # gateway/judge 外部运行时契约
│       │   ├── slo.ts                    # SLO 计算与校验
│       │   └── alerts.ts                 # 快照告警规则
│       └── tests/
└── app.ts                                # 组合根
```

### 4.4 现有文件迁移映射

| 现有文件 | 目标位置 |
|---|---|
| `shared/base/metrics.ts` | `shared/observability/registry.ts` + `shared/observability/contracts.ts` |
| `shared/middleware/metrics.ts` | `domains/observability/middleware/http-metrics.ts` |
| `shared/middleware/request-context.ts` | `domains/observability/middleware/request-context.ts`（上下文实现留在 `shared/observability/context.ts`） |
| `shared/base/logging.ts` 的请求上下文部分 | `shared/observability/context.ts`（logger 实现仍可在 `shared/base/logging.ts`，避免 shared 反向依赖 domain） |
| `routes/health.ts` | `domains/observability/routes/health.ts` |
| `domains/system/services/observability.ts` | 拆分到 `domains/observability/services/{snapshot,judge-heartbeat,alerts}.ts` |
| `domains/admin/routes/query.ts` 的观测路由 | `domains/observability/routes/admin.ts`，由 admin 门面挂载 |
| 各业务域 `metrics.inc(...)` | 改为 import `domains/observability/write.ts` |

### 4.5 CI 边界检查扩展

扩展现有 `scripts/check-domains.ts`：

- `DOMAINS` 新增 `observability`。
- 新增 `PUBLIC_SUBPATHS = { observability: ["write.ts"] }`：允许业务域 import `domains/observability/write.ts`，但仍禁止深路径 import `services/`、`routes/`、`metrics/`。
- `domains/admin` 额外允许 import `domains/observability/index.ts`（仅用于挂载管理路由）；其他业务域不享受该例外。
- 新增 `NO_CROSS_DOMAIN_DOMAINS = new Set(["observability"])`：观测域不得 import 任何其他域，即使是 `index.ts`。
- `checkFile` 需要知道 sourceDomain：仅当 sourceDomain 不是 `admin` 时，才禁止 import `domains/observability/index.ts`；`write.ts` 对所有业务域开放。
- 保持 `shared → domains` 的现有禁止规则。
- 新增 `scripts/check-metrics.ts`：扫描 `registerBusinessMetric` 调用，校验命名、owner、标签白名单、基数上限，并生成 `dev-docs/engineering/metric-catalog.md`。
- 新增 `scripts/check-runtime-contract.ts`：校验 `runtime-contract.ts` 的 `requiredMetrics` 与 Prometheus 配置、gateway/judge 测试 fixture 一致。
- 新增 `scripts/check-runbooks.ts`：校验告警规则中的 Runbook 链接存在。
- 所有检查接入 `scripts/check-all.ts` 与 CI。

## 5. 写侧契约、注册表与指标目录

### 5.1 Kernel 契约

```ts
// shared/observability/contracts.ts
export type MetricType = "counter" | "gauge" | "histogram";
export type MetricLabels = Readonly<Record<string, string | number | boolean>>;

export interface MetricDefinition {
  name: string;              // noj_<area>_<metric>_<unit>
  help: string;              // 中文描述，必填
  type: MetricType;
  owner: string;             // platform | identity | submission | contest | ...
  labels?: readonly string[]; // 白名单标签
  buckets?: readonly number[];
}

export interface MetricSink {
  define(def: MetricDefinition): void;
  inc(name: string, labels?: MetricLabels, amount?: number): void;
  set(name: string, value: number, labels?: MetricLabels): void;
  add(name: string, amount: number, labels?: MetricLabels): void;
  observe(name: string, value: number, labels?: MetricLabels): void;
}

export interface HealthProbeResult {
  status: "up" | "down" | "unknown";
  latency_ms?: number;
  detail?: Record<string, unknown>;
  error?: string;
}

export interface HealthProbe {
  name: string;
  critical: boolean;
  timeoutMs?: number;
  check(): Promise<HealthProbeResult> | HealthProbeResult;
}

export interface SnapshotProvider<T = unknown> {
  name: string;
  timeoutMs?: number;
  collect(): Promise<T>;
}

export interface ObservabilityRegistry extends MetricSink {
  registerHealthProbe(probe: HealthProbe): void;
  registerSnapshotProvider(provider: SnapshotProvider): void;
  registerBusinessMetric(def: MetricDefinition): void;
  sum(name: string): number;
  count(name: string): number;
  render(): string;
}
```

### 5.2 唯一业务入口

```ts
// domains/observability/write.ts
export { observability } from "../../shared/observability/registry.ts";
export type {
  MetricDefinition,
  HealthProbe,
  SnapshotProvider,
} from "../../shared/observability/contracts.ts";
export type { ObservabilitySnapshot } from "./types.ts";

export function registerBusinessMetric(def: MetricDefinition): void;
export function registerHealthProbe(probe: HealthProbe): void;
export function registerSnapshotProvider(
  provider: SnapshotProvider<Partial<ObservabilitySnapshot>>,
): void;
```

- 业务域只能 import 这个文件，不能碰观测域内部实现。
- `shared/db`、`shared/mq` 等直接依赖 `shared/observability`，不经 domain。
- 平台指标定义在 `domains/observability/metrics/platform.ts`，由观测域启动时注册。
- `registerBusinessMetric`、`registerHealthProbe`、`registerSnapshotProvider` 是 `observability` 同名方法的薄封装，便于调用点简洁；两者行为一致。

### 5.3 指标所有权与命名规则

| 类别 | 定义者 | 命名 | 例子 |
|---|---|---|---|
| 平台/基础设施 | 观测域中央定义 | `noj_<area>_<metric>_<unit>` | `noj_http_requests_total`、`noj_redis_up` |
| 业务 | 各业务域自注册 | `noj_<domain>_<metric>_<unit>` | `noj_submission_e2e_duration_seconds` |
| 自观测 | kernel 固定定义 | `noj_observability_<metric>_<unit>` | `noj_observability_metric_dropped_total` |

硬约束（注册时 + CI 双重校验）：

- `owner` 必须与 `src/domains/<owner>/` 目录一致；平台指标 owner 固定为 `platform`。
- 标签白名单：`method`、`route`、`status`、`queue`、`provider`、`language`、`result`、`type`、`criticality`。
- 禁止标签：`user_id`、`submission_id`、`problem_id`、`request_id`、`trace_id`、`contest_id` 等一切动态 ID。
- 单指标最多 5 个标签；单序列最多 1000 条（可通过 `OBSERVABILITY_MAX_SERIES` 配置）；标签值 ≤ 64 字符且拒绝 UUID 形态。
- 指标必须先 `define` 再写入；未定义写入 = no-op + 自观测错误计数。
- 指标名必须唯一；重复定义同名同类型幂等，类型冲突忽略并记录 warning。

### 5.4 Fail-open 语义

| 故障 | 行为 |
|---|---|
| 写入未定义指标 | 丢弃样本，`noj_observability_write_errors_total{reason="unknown_metric"}` |
| 标签非法/含动态 ID | 丢弃样本，`reason="invalid_label"` |
| 单指标序列超限 | 丢弃新序列，`noj_observability_metric_dropped_total{reason="cardinality"}` |
| 重复定义/类型冲突 | 幂等忽略，记录一次 warning；测试用 `strict: true` 实例可抛错 |
| `render()` 内部异常 | 返回已渲染部分，不抛错 |
| 自观测计数器本身失败 | 静默忽略，绝不冒泡到业务 |

实现要求：

- `MetricSink` 所有方法内部 try/catch，返回 `void`；业务调用点不需要写 try/catch。
- `createObservabilityRegistry({ strict?: boolean })` 工厂；运行时单例 `strict: false`，测试可用 `strict: true`。
- 自观测计数器使用固定、有界的标签集合，禁止使用用户输入作为标签。

### 5.5 测试

- 单元测试：未知指标、非法标签、基数溢出、类型冲突、标签转义、渲染稳定性、`strict` 模式。
- 契约测试：业务域只能 import `write.ts`；`shared/**` 不得 import `domains/**`；观测域不得 import 业务域。
- 目录测试：`check-metrics.ts` 的命名/owner/标签校验；`metric-catalog.md` 生成结果与注册调用一致。

## 6. 读侧：健康探针、快照聚合与管理员 API

### 6.1 探针与 Provider 注册表

```ts
// domains/observability/probes/registry.ts
interface RegisteredProbe extends HealthProbe {
  timeoutMs: number;
}

interface RegisteredProvider extends SnapshotProvider {
  timeoutMs: number;
}
```

注册责任划分：

| 探针/Provider | 注册者 | 内容 |
|---|---|---|
| `database` | `shared/db`（导出 `registerDbHealthProbe(registry)`） | `checkDbHealth()` + 延迟 |
| `redis` | `shared/mq`（导出 `registerRedisHealthProbe(registry)`） | `checkRedisHealth()` + 延迟 |
| `result_consumer` | `domains/submission` | `consumerAlive` 状态 |
| `submission.queue` | `domains/submission` | pending/processing/result/judging/oldest age（只查自己的表） |
| `judge.heartbeat` | `domains/observability` | Redis TTL 心跳聚合 |
| `api.metrics` | `domains/observability` | 自身 registry 的 HTTP 指标 |
| `alerts` | `domains/observability` | 快照告警规则 |

所有探针和 provider 都由 `app.ts` 组合根显式注册（调用各 owner 导出的注册函数）；观测域不 import 任何业务域。`shared/db`、`shared/mq` 只依赖 `shared/observability` kernel，不 import `domains/observability`。当前 `readDatabaseQueueStats()` 直接查 `submissions` 表，重构后由 submission 域提供，修正表所有权。

### 6.2 健康探针语义

| 端点 | 行为 |
|---|---|
| `/health/live` | 只证明进程能处理 HTTP，不检查任何外部依赖，永远 200 |
| `/health/ready` | 并发执行所有 critical 探针；全部 `up` 才 200，否则 503 |
| `/health` | 兼容旧语义：始终 200 + `healthy`/`degraded`，附依赖详情（生产隐藏细节） |

- 探针自身异常/超时不会让进程崩溃，也不会抛 500。
- readiness fail-closed：`unknown` 和 `down` 都返回 503。
- 每个探针独立超时；慢探针只影响自己的状态，不阻塞其他探针。
- 增加 single-flight + 短 TTL 缓存（默认 1s）：避免 `/health/ready` 和 `/metrics` 同时触发重复 DB/Redis 健康检查。

### 6.3 快照聚合

```ts
interface ObservabilitySnapshot {
  generated_at: string;
  dependencies: { database; redis; result_consumer; [k: string]: unknown };
  queue: {
    pending: number | null;
    processing: number | null;
    result_pending: number | null;
    result_processing: number | null;
    judging: number | null;
    oldest_judging_age_seconds: number | null;
  };
  api: {
    requests_total: number;
    errors_total: number;
    rate_limited_total: number;
    error_rate_percent: number;
    average_latency_ms: number | null;
  };
  judge: { workers; active_tasks; max_concurrent_tasks; ... };
  alerts: ObservabilityAlert[];
  providers: {
    name: string;
    status: "ok" | "error" | "timeout";
    duration_ms: number;
    error?: string;
  }[];
}
```

- 每个 provider 独立超时、独立 catch；失败时对应字段保持 `null`/`unknown`，`providers[]` 记录 `error/timeout`。
- 整体 `generated_at` 和已成功的部分照常返回，HTTP 始终 200；观测自身降级不阻断观测读取。
- `providers[]` 是增量字段，不删除旧字段，管理端 UI 可逐步消费。
- 自观测指标：`noj_observability_snapshot_duration_seconds`、`noj_observability_snapshot_provider_errors_total{provider}`、`noj_observability_health_probe_errors_total{probe}`、`noj_observability_snapshot_cache_hits_total`。

### 6.4 Judge 心跳协议

- 观测域拥有 core 侧协议：Redis key 前缀 `noj:observability:judge:<instance>`、TTL 30s、10s 刷新周期。
- 心跳 JSON 增加 `schema_version`；core 侧按版本解析，未知字段忽略、缺字段补默认值、malformed 丢弃并 warning。
- Rust 侧仍是上报方；本期只收敛 core 侧读取逻辑，不要求改 judge 协议格式（可增量加 `schema_version`）。
- `SCAN MATCH` + 每 key 读取 + 1000 上限保护，避免 Redis 大 key 扫描拖慢。
- 心跳字段保持低基数：active_tasks、max_concurrent_tasks、completed/failed、result_push_failures、orphan_containers、cache_items、cache_bytes、work_dir_bytes、updated_at_ms。

### 6.5 管理员观测 API

- 路由文件 `domains/observability/routes/admin.ts` 只导出 Hono router，不 import identity。
- `domains/admin/index.ts` 导入并在现有路径 `/api/v1/admin/dashboard/observability` 挂载，复用 `adminMiddleware`，保持 RBAC 与前端路径不变。
- 响应体在现有快照基础上增加 `providers[]`，前端 `usePolling` 逻辑不需要改；后续可单独迭代 UI。

### 6.6 测试

- 健康路由：`up/down/unknown/timeout` 四种状态；readiness 503；`/health` 兼容 200。
- 快照：provider 抛错/超时/返回 partial；部分成功；`providers[]` 状态正确。
- 缓存：single-flight 并发只触发一次探针；TTL 过期后刷新。
- 管理路由：管理员 200、普通用户 403、匿名 401；路径与响应字段兼容。

## 7. 外部运行时契约与指标扩充

### 7.1 外部运行时接入契约

观测域定义统一契约（`domains/observability/services/runtime-contract.ts`）：

```ts
interface RuntimeDescriptor {
  name: "noj-llm-gateway" | "noj-judge";
  contractVersion: 1;
  mode: "http" | "heartbeat";
  healthUrl?: string;
  metricsUrl?: string;
  heartbeatKey?: string;
  requiredMetrics: readonly string[];
}
```

| 运行时 | 本期模式 | 说明 |
|---|---|---|
| noj-llm-gateway | HTTP | 新增 `/health/live`、`/health/ready`、`/metrics`；由 Prometheus 直接抓取 |
| noj-judge | heartbeat（兼容） | 保留现有 Redis TTL 心跳；契约预留 `mode: "http"`，未来可加 `/metrics` |

- Prometheus 直抓，不经 core 代理；core 只负责健康状态聚合（`runtimes` section）。
- 契约校验：`requiredMetrics` 与 `deploy/monitoring/prometheus.yml` 的 job 由 `scripts/check-runtime-contract.ts` 静态校验；跨模块 E2E 在 `noj-tests` 增加“gateway `/metrics` 包含契约指标”断言。
- 安全边界：所有 `/metrics`、`/health/*` 只绑定内部网络，不映射公网；指标禁止携带 provider key、用户 ID、prompt 内容。
- 版本协商：`/health/live` 返回 `contract_version`；core 记录不匹配 warning，不阻断业务。

### 7.2 指标扩充清单

| 类别 | 新增指标（示例） | 标签白名单 |
|---|---|---|
| HTTP/平台 | `noj_http_requests_in_flight`、`noj_http_request_size_bytes`、`noj_http_response_size_bytes`、`noj_http_sse_connections`、`noj_http_slow_requests_total` | `method`、`route`、`status` |
| 基础设施/资源 | `noj_db_pool_connections{state}`、`noj_db_query_duration_seconds{operation}`、`noj_redis_memory_used_bytes`、`noj_redis_hit_ratio`、`noj_storage_bytes{bucket}`、`noj_process_resident_memory_bytes` | `state`、`operation`、`bucket` |
| Judge 细粒度 | `noj_judge_container_start_duration_seconds`、`noj_judge_cache_hits_total`、`noj_judge_cache_misses_total`、`noj_judge_task_duration_seconds`、`noj_judge_orphan_cleanup_duration_seconds`、`noj_judge_sandbox_memory_bytes` | `language`、`result`、`cache` |
| LLM 网关 | `noj_llm_requests_total{provider,status}`、`noj_llm_request_duration_seconds{provider}`、`noj_llm_tokens_total{provider,type}`、`noj_llm_rate_limited_total{provider}`、`noj_llm_quota_exhausted_total{provider}`、`noj_llm_provider_errors_total{provider,reason}` | `provider`、`status`、`type`、`reason` |
| 业务 SLI | `noj_submission_e2e_duration_seconds`、`noj_queue_oldest_pending_age_seconds`、`noj_result_delivery_duration_seconds`、`noj_evaluation_throughput_total`、`noj_contest_ranking_update_latency_seconds` | `result`、`language`、`queue` |

基数控制：

- `provider`、`language`、`result`、`queue` 都是有界枚举。
- `reason` 需要固定枚举表，禁止自由文本。
- 禁止把 `problem_id`、`user_id`、`submission_id` 引入标签。
- 每个新指标都必须进 `check-metrics.ts` 的 catalog。

分期：

- **P0（本次重构一起做）**：HTTP/平台、业务 SLI、Judge 细粒度（core 能聚合的部分）、基础设施资源（DB/Redis/进程）。
- **P1**：LLM 网关 `/metrics` + 契约校验。
- **P2**：MinIO/存储、更细的 sandbox 资源指标。

## 8. SLO 与告警规则

### 8.1 SLO 定义

新增 `domains/observability/slo.ts`：

```ts
interface SloDefinition {
  id: string;                 // api_availability
  title: string;              // 核心 API 可用性
  sli: string;                // PromQL 表达式或指标名
  objective: number;          // 0.995
  window: "30d";
  burnRateWindows: { long: string; short: string }; // 1h/5m, 6h/30m
  runbook: string;            // 相对路径
}
```

覆盖：

- API 可用性：非 5xx 请求 / 总请求。
- 提交端到端延迟：`noj_submission_e2e_duration_seconds`。
- 队列最老 pending 年龄：`noj_queue_oldest_pending_age_seconds`。
- 结果回传延迟：`noj_result_delivery_duration_seconds`。
- 评测吞吐：`noj_evaluation_throughput_total`。

### 8.2 告警规则生成与校验

- `scripts/gen-alert-rules.ts` 从 SLO 定义生成或校验 `deploy/monitoring/noj-alerts.yml` 的 recording rules 与 burn-rate 告警；生成产物提交到仓库，CI 校验无漂移。
- 每条 SLO 告警必须绑定 Runbook；`scripts/check-runbooks.ts` 校验链接可解析。
- 自观测：`noj_observability_slo_evaluation_errors_total`，SLO 计算失败不影响主链路。
- 规则文件仍需通过 `promtool check rules`（CI 有 promtool 时执行；无 promtool 时用 YAML 解析与静态断言）。

## 9. 部署侧监控资产

| 资产 | 改动 |
|---|---|
| `deploy/monitoring/prometheus.yml` | 新增 `noj-gateway` job；judge 仍走心跳聚合；保留 `node` 可选段 |
| `deploy/monitoring/noj-alerts.yml` | 改为由 `slo.ts` 生成/校验，覆盖 SLO burn-rate、队列、依赖、Judge、缓存/磁盘 |
| `deploy/monitoring/grafana-dashboard.json` | 拆成平台总览、Judge、LLM Gateway、业务 SLI 四块（或一个带 row 的 dashboard） |
| `deploy/monitoring/runbooks/` | 每条 SLO/告警一个中文 Runbook；`check-runbooks.ts` 校验链接 |
| `docker-compose.prod.yml` / `deploy/nginx/default.conf` | `/metrics`、`/health/*` 只走内部网络，不暴露公网 |
| `.env.prod.example` | 新增 `OBSERVABILITY_SNAPSHOT_TIMEOUT_MS`、`OBSERVABILITY_CACHE_TTL_MS`、`OBSERVABILITY_MAX_SERIES`、`RUNTIME_*_URL` |
| `deploy/monitoring/README.md` | 更新抓取目标、契约版本、验证清单 |

新增的 `OBSERVABILITY_*`、`RUNTIME_*` 环境变量必须同步登记到 `noj-core/src/shared/config/settings-registry.ts` 与 `noj-core/.env.example`，并通过 `deno task check:env`；否则启动校验会失败。

可选 P2：`noj-cli observability check` 包装 `/health/live`、`/health/ready`、`/metrics`、规则文件与 Runbook 链接检查，让运维一条命令自检。本期不做。

## 10. 测试与 CI

| 层级 | 内容 | 命令 |
|---|---|---|
| 单元 | registry fail-open、标签/基数校验、探针 up/down/unknown/timeout、snapshot provider 失败、single-flight 缓存 | `deno task test:domain observability` |
| 契约 | 业务域只 import `write.ts`（admin 挂载管理路由例外）；观测域不 import 业务域；shared 不 import domains；运行时契约指标齐全 | `deno task check:domains` + `scripts/check-metrics.ts` + `scripts/check-runtime-contract.ts` |
| 集成 | `/health/live`、`/health/ready`、`/metrics`、管理员快照在真实 DB/Redis 下的行为 | `bash scripts/test-shared.sh` |
| 跨模块 E2E | gateway `/metrics` 契约、judge 心跳聚合、快照 `providers[]` 状态 | `cd noj-tests && deno task test:domain cross-domain` |
| 性能 | 快照聚合在 provider 超时下不拖慢 `/metrics`；健康探针 single-flight 只触发一次 | 观测域性能测试 |
| 门禁 | 以上全部接入 `scripts/check-all.ts` / CI | `deno task check` |

新增脚本：

- `scripts/check-metrics.ts` + 测试。
- `scripts/check-runtime-contract.ts` + 测试。
- `scripts/check-runbooks.ts` + 测试。
- 扩展 `scripts/check-domains.ts` + 测试。

## 11. 迁移计划

采用一次性重构，无兼容层。建议同一分支内按以下顺序提交，每一步保证 `deno check` 全绿。

1. **Kernel 抽取**：新建 `shared/observability/`，迁移 registry/契约/上下文；更新 `shared/db`、`shared/mq`、`shared/base/logging` 的 import 与相关测试；删除 `shared/base/metrics.ts`。
2. **平台域骨架**：新建 `domains/observability/`，迁移 health、snapshot、judge heartbeat、admin 路由；实现探针/Provider 注册表与 single-flight 缓存。
3. **业务域迁移**：各域改 import `domains/observability/write.ts`；新增 `register<Domain>Observability(registry)` 导出；注册业务指标与 snapshot provider。
4. **组合根**：`app.ts` 统一注册平台指标、探针、provider，挂载路由；admin 门面挂载观测管理路由。
5. **边界与门禁**：扩展 `scripts/check-domains.ts`（`observability` 域、`write.ts` 白名单、观测域禁跨业务域）；新增 `check-metrics.ts`、`check-runtime-contract.ts`、`check-runbooks.ts`。
6. **部署资产与文档**：更新 Prometheus/Grafana/Alertmanager/Runbook、`.env.prod.example`、`noj-core/src/shared/config/settings-registry.ts`、`noj-core/.env.example`、`noj-core/CLAUDE.md`、`dev-docs/engineering/domain-boundaries.md`、`metric-catalog.md`；补 Agent Note。
7. **验收**：`deno task check`、`deno task test:domain observability`、`bash scripts/test-shared.sh`、跨模块 E2E 全绿。

回滚：

- 没有数据库迁移；回滚 = revert 变更集或回退镜像。
- 对外 HTTP 路径与响应语义保持不变，回滚不会影响 Prometheus/Nginx/UI 配置。
- 一次性重构意味着没有运行时开关；如果上线后发现严重问题，优先回退镜像，再修复后重新发布。

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 模块初始化顺序导致指标未定义就写入 | 注册在模块顶层、写入前完成；单测覆盖“未定义写入 = no-op” |
| 观测域反向 import 业务域形成环 | `check-domains.ts` 新增“观测域禁止跨业务域”规则；provider 注册由组合根完成 |
| 健康/指标路径被破坏 | 保留 `/health*`、`/metrics`、`/api/v1/admin/dashboard/observability` 路径与语义，加路由契约测试 |
| 高基数标签打爆 Prometheus | 注册期白名单 + CI catalog + 运行期 1000 序列上限 |
| 快照聚合拖慢 `/metrics` | 每 provider 独立超时 + single-flight + 短 TTL 缓存；聚合失败返回部分数据 |
| 一次性重构范围过大 | P0/P1/P2 分期；P0 只做 core 内 domain + 指标扩充，gateway `/metrics` 放 P1 |
| 业务域忘记注册指标导致静默丢数据 | `check-metrics.ts` 同时扫描 `registerBusinessMetric` 定义和 `inc/set/add/observe` 写入调用，任何未进 catalog 的指标名直接 CI 失败；运行期未定义写入产生自观测错误计数并在测试中断言 |
| 观测自身故障无法定位 | 自观测指标 + `providers[]` 状态 + 快照 `generated_at` |

## 13. 验收矩阵

| 验收标准 | 验证方式 |
|---|---|
| Fail-open：观测不影响主链路 | 故障注入单测：registry 异常、provider 超时、探针抛错均不产生 500 |
| 单向依赖 + CI 边界 | `check-domains.ts` 新增规则 + 契约测试 |
| 指标扩充 | `check-metrics.ts` catalog + 五类指标单测/集成测试 |
| 对外路径兼容 | 路由契约测试覆盖旧路径与响应字段 |
| Provider 聚合无环 | 观测域无业务域 import；组合根注册 provider 的集成测试 |
| 部署资产一致 | `check-runtime-contract.ts`、`check-runbooks.ts`、YAML 解析测试 |

## 14. 后续演进

- **可外迁**：`MetricSink` / `HealthProbe` / `SnapshotProvider` 接口保持稳定后，可把 `domains/observability` 的实现替换为远程 sink 或独立观测服务，业务调用点不变。
- **trace_id**：本期在 `shared/observability/context.ts` 预留字段；后续接入 OpenTelemetry 时，只需在中间件层补齐传播，不改业务代码。
- **多实例**：指标按实例暴露，Prometheus 聚合；若未来 core 多副本，快照 API 需要按实例区分或引入聚合层。
- **日志平台**：结构化日志字段已经统一，后续可接 Loki/ELK，不需要改业务日志调用。
- **前端 RUM**：本期未纳入，后续可作为独立变更。

## 15. 参考

- `openspec/changes/production-observability/proposal.md`
- `openspec/changes/production-observability/design.md`
- `dev-docs/engineering/domain-boundaries.md`
- `dev-docs/engineering/testing.md`
- `scripts/check-domains.ts`
- `noj-core/src/app.ts`
- `noj-core/src/shared/base/metrics.ts`
- `noj-core/src/routes/health.ts`
- `noj-core/src/domains/system/services/observability.ts`
- `deploy/monitoring/README.md`
