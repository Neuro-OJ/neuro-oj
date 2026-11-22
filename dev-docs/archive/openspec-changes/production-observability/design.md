## Context

See `proposal.md` for the motivation. `noj-core` 当前只有综合 `/health`，Redis 使用 ioredis，评测结果消费者已经暴露进程内存活标志，队列服务已有 pending/processing 长度查询。`noj-judge` 使用 Tokio、Redis 和 Docker，生产 Compose 仅将 core/judge 暴露在内部网络，当前没有现成的 Prometheus client 或监控服务。

## Goals / Non-Goals

**Goals:**

- 建立无需新增重量级依赖的指标采集、健康探针和管理端观测闭环。
- 用低基数标签和聚合心跳保护敏感数据与 Prometheus 性能。
- 让 Judge Worker 崩溃、队列堆积、依赖故障和缓存/磁盘压力可以被机器告警发现。
- 提供可复制的 Prometheus/Grafana 配置和中文 Runbook。

**Non-Goals:**

- 不在应用仓库内绑定 Grafana Cloud、PagerDuty、企业微信或其他厂商通知服务。
- 不采集用户级、提交级、代码级或 LLM prompt/token 内容。
- 不把完整历史时序数据写入 PostgreSQL；历史数据由 Prometheus 保存。
- 不在本变更中完成压测容量模型（属于 Issue #329）。

## Decisions

### 1. 使用自包含指标注册表，不新增运行时依赖

core 使用小型进程内 counter/gauge/histogram 注册表输出 Prometheus 0.0.4 文本格式。HTTP 中间件记录 method、归一化 route、status；业务和健康代码更新聚合指标。这样保持 Deno 依赖面稳定，也适合当前单进程部署。Prometheus 的 `rate()`、`histogram_quantile()` 负责时间窗口和分位数计算。

备选方案是引入完整 OpenTelemetry SDK；它能覆盖更多后端，但会增加依赖、配置和导出链路复杂度，不适合当前只有单一服务和明确指标集合的范围。

### 2. 通过 Redis TTL 心跳聚合 Judge 状态

Judge 每 10 秒将一个 JSON 聚合快照写入 `noj:observability:judge:<instance>`，TTL 为 30 秒。core 使用 `SCAN MATCH` 读取心跳并汇总，不读取队列中的完整任务 JSON，也不依赖 Judge HTTP 端口。Worker 活跃任务和结果计数用原子计数器维护；缓存/工作目录大小在心跳刷新时按受控目录扫描。

备选方案是新增 Judge metrics HTTP 端口并让 Prometheus 直接抓取每个 Worker。该方案需要额外端口、服务发现和网络暴露配置，且无法直接供 core 管理面板复用；TTL 心跳更符合现有 Redis 协作模型。

### 3. 保留 `/health`，新增 `/health/live` 和 `/health/ready`

现有 `/health` 返回结构化综合状态，已有 Nginx `/healthz` 和测试依赖它，因此继续保留。新增 liveness 不检查外部依赖；readiness 负责数据库、Redis 和消费者状态，并以 503 阻断流量。生产 Compose/Nginx 探活改用 readiness，避免把 degraded 实例继续当作可接收业务流量的实例。

### 4. 管理端观测使用 admin API，不让浏览器抓取 `/metrics`

Prometheus 指标端点保持内部抓取用途；管理后台通过受 RBAC 保护的 JSON 快照 API 获取经过裁剪的观测数据。仪表盘沿用现有 `/admin` 页面和 `usePolling`，避免新增长连接和重复的前端状态体系。

### 5. 告警配置与应用运行时解耦

仓库提供 Prometheus rule file、示例 scrape 配置和 Grafana dashboard JSON；通知接收器留给部署方配置。告警名称、阈值和 Runbook 链接固定，避免不同部署环境出现无法解释的告警。

## Risks / Trade-offs

- [进程内指标在重启后归零] → 使用 Prometheus 长期存储和 `rate()`/`increase()`，管理面板同时展示当前快照；不把累计值当作跨重启审计数据。
- [多实例 core 各自维护指标] → Prometheus 按实例抓取并聚合；指标不使用实例以外的高基数标签。
- [Redis 心跳扫描有额外开销] → 使用 `SCAN` 而非 `KEYS`，心跳 TTL 短且 Worker 数量预期有限；依赖不可用时安全返回 unknown。
- [目录扫描可能影响 Judge] → 仅扫描缓存 ZIP 和 fallback/work 目录的文件元数据，并在心跳周期执行；失败时报告 unknown，不阻断评测。
- [没有自动配置外部通知渠道] → 提供 `alertmanager` 接入说明和可执行的通知链路检查 Runbook；应用默认不保存通知凭据。
- [无法仅凭应用指标准确表示宿主机磁盘] → Judge 输出工作目录/缓存占用，Prometheus 示例同时预留 node_exporter 的宿主机磁盘指标，并在 Runbook 中区分两者。

## Migration Plan

1. 发布 core 与 judge 新版本；新 core 兼容旧 Judge，旧 Judge 不发送心跳时面板显示无在线 Worker。
2. 在 Prometheus 中加载 `deploy/monitoring/prometheus.yml` 和 `deploy/monitoring/noj-alerts.yml`，按部署网络调整 core 地址及可选 node_exporter 地址。
3. 导入 `deploy/monitoring/grafana-dashboard.json`，配置 Prometheus datasource。
4. 配置 Alertmanager 的通知接收器后，按 Runbook 执行 `/health/live`、`/health/ready`、`/metrics` 和规则加载检查。
5. 回滚时可回退应用镜像；旧版本不识别新端点不会影响既有业务，Prometheus 对缺失指标的告警应随规则版本一起回滚或禁用。
