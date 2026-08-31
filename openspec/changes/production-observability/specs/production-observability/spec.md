## Purpose

为 Neuro OJ 提供面向生产环境的统一可观测性契约，使运维人员能够持续采集服务、依赖、评测队列和 Judge Worker 状态，并依据明确告警和 Runbook 处理常见故障。

## ADDED Requirements

### Requirement: Service metrics are exposed in a scrapeable format

系统 SHALL 提供一个 Prometheus 兼容的指标端点，输出 API 请求量、低基数路由与状态码、请求延迟、限流次数、数据库/Redis 健康状态、评测队列和 Judge Worker 聚合指标。指标 SHALL 不包含用户 ID、提交 ID、代码、提示词、凭据或其他高基数/敏感值。

#### Scenario: Metrics endpoint returns stable exposition data

- **WHEN** 采集器访问指标端点
- **THEN** 系统返回 `text/plain` Prometheus exposition 数据，并至少包含 HTTP 请求总数、请求延迟、队列长度、依赖状态和 Judge Worker 状态指标

#### Scenario: Metrics remain available during dependency degradation

- **WHEN** PostgreSQL、Redis 或结果消费者不可用
- **THEN** 指标端点仍返回可解析的指标数据，并将对应依赖指标标记为不可用，而不是因采集失败返回未处理的 500

#### Scenario: Sensitive and unbounded labels are rejected

- **WHEN** 请求路径包含用户、题目或提交的动态标识符
- **THEN** HTTP 指标使用路由模板或归一化的低基数路径，且输出中不出现这些标识符

### Requirement: Health probes distinguish liveness from readiness

系统 SHALL 提供独立的 liveness 和 readiness 探针。liveness 仅表示进程能够处理探活请求；readiness SHALL 检查 PostgreSQL、Redis 和评测结果消费者等接收业务流量所需依赖，并在未就绪时返回 HTTP 503。既有综合健康端点 SHALL 保持兼容。

#### Scenario: Live process is reported alive without dependencies

- **WHEN** 进程正在运行但 PostgreSQL 或 Redis 不可用
- **THEN** liveness 探针返回 HTTP 200，且不执行依赖检查

#### Scenario: Ready service returns success

- **WHEN** PostgreSQL、Redis 和结果消费者均正常
- **THEN** readiness 探针返回 HTTP 200，并报告 ready 状态

#### Scenario: Unready service is excluded from traffic

- **WHEN** 任一 readiness 依赖检查失败
- **THEN** readiness 探针返回 HTTP 503，并报告 degraded/not-ready 状态；生产环境响应不泄露内部错误详情

### Requirement: Judge Worker health is observable through expiring heartbeats

每个 Judge Worker SHALL 定期向 Redis 写入带过期时间的聚合心跳，至少包含活跃任务数、并发上限、完成/失败任务计数、孤儿容器数、支持包缓存条目数与字节数、工作目录字节数和最近更新时间。Worker 停止更新后，心跳 SHALL 在有限时间内失效，core 不得继续将其计为在线。

#### Scenario: Active Judge Worker publishes aggregate status

- **WHEN** Judge Worker 正常运行并处理或等待任务
- **THEN** Redis 中存在带 TTL 的 Worker 心跳，且不包含提交 ID、用户 ID 或用户代码

#### Scenario: Crashed Judge Worker expires

- **WHEN** Judge Worker 停止并且不再刷新心跳
- **THEN** 心跳在 TTL 内过期，core 的聚合指标将该 Worker 从在线实例中移除

#### Scenario: Worker metrics cover cache and orphan cleanup risks

- **WHEN** 运维查看聚合指标或管理端观测面板
- **THEN** 可以看到活跃任务、失败任务、孤儿容器、缓存条目/字节数和工作目录占用等指标

### Requirement: Administrators can inspect an operational observability snapshot

系统 SHALL 提供仅管理员可访问的观测快照 API 和管理后台观测区域，展示依赖状态、队列长度、评测状态、在线 Judge Worker、关键指标和当前风险。快照 SHALL 在部分依赖失败时保留可用数据并明确标注 unknown/degraded，而不是整体不可用。

#### Scenario: Administrator loads the observability snapshot

- **WHEN** 管理员访问观测快照 API 或管理后台仪表盘
- **THEN** 系统返回依赖、队列、Judge、API 错误/延迟和风险状态，并支持定时刷新

#### Scenario: Non-administrator is denied

- **WHEN** 普通用户或匿名用户访问观测快照 API
- **THEN** 系统拒绝请求，且响应不包含内部依赖、队列或 Worker 信息

#### Scenario: Partial failure is visible

- **WHEN** Redis 或 PostgreSQL 暂时不可用
- **THEN** 面板显示对应组件为 degraded/unknown，并保留其他可读取的观测数据和最近成功刷新时间

### Requirement: Production alert rules and Runbooks are provided

仓库 SHALL 提供可导入 Prometheus/Grafana 的采集配置、仪表盘和告警规则，覆盖 API 错误率/延迟、队列堆积、评测卡死或结果队列积压、数据库/Redis 异常、Judge Worker 消失、磁盘/缓存占用过高。每条关键告警 SHALL 有对应的中文处理 Runbook、确认步骤、缓解步骤和恢复验证步骤。

#### Scenario: Alert configuration detects critical dependency failure

- **WHEN** readiness 失败或数据库/Redis up 指标持续为 0
- **THEN** Prometheus 告警规则在规定持续时间后触发 critical 告警，并指向对应 Runbook

#### Scenario: Alert configuration detects queue or disk pressure

- **WHEN** pending/processing 队列、Judge 工作目录或宿主机可用磁盘超过配置阈值
- **THEN** Prometheus 告警规则触发 warning/critical 告警，并说明清理、扩容或暂停入口的操作

#### Scenario: Operator can verify the notification chain

- **WHEN** 运维按照文档执行观测检查和告警演练
- **THEN** 可以验证指标可抓取、告警规则可加载、通知渠道已配置，并完成一次可回滚的故障演练记录
