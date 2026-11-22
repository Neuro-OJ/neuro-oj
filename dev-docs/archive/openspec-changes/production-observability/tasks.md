## 1. Core metrics and request instrumentation

- [x] 1.1 新增无外部依赖的低基数 counter/gauge/histogram 注册表与 Prometheus exposition 输出，覆盖标签转义、空指标、重置测试和敏感字段过滤；用 core 单元测试验证
- [x] 1.2 增加 API 请求中间件，记录归一化 route、method、status、请求总数、错误数、限流数和延迟；用路由测试验证动态 ID 不出现在指标中
- [x] 1.3 将数据库、Redis、结果消费者、队列和结果消费事件接入指标；验证依赖异常时指标端点仍返回可解析数据
- [x] 1.4 增加 `/metrics` 端点并补充 content type、错误降级和回归测试；用 Hono `app.request()` 验证响应

## 2. Health and operational snapshot

- [x] 2.1 增加 `/health/live` 和 `/health/ready`，让 readiness 在依赖未就绪时返回 503，同时保持 `/health` 兼容；用健康路由测试覆盖成功、降级和不依赖检查场景
- [x] 2.2 增加观测快照服务，聚合数据库/Redis、pending/processing/result 队列、judging 数量、指标摘要和 Judge 心跳；验证 Redis/数据库故障时返回部分数据与 unknown 状态
- [x] 2.3 增加管理员观测快照 API，并通过现有 admin RBAC 守卫保护；用路由测试验证管理员可读、普通用户和匿名用户被拒绝

## 3. Judge Worker heartbeat

- [x] 3.1 新增 Judge Worker 聚合指标状态，跟踪活跃任务、完成/失败任务、结果推送失败和并发上限；用 Rust 单元测试验证计数与并发状态变化
- [x] 3.2 定期向 Redis 写入 `noj:observability:judge:<instance>` TTL 心跳，并采集孤儿容器、支持包缓存和工作目录占用；用配置/序列化测试验证无提交级敏感字段
- [x] 3.3 让 core 使用 SCAN 聚合有效 Judge 心跳，过期心跳不计入在线实例；用 Redis mock 或服务测试覆盖在线、过期和 malformed 心跳

## 4. Admin dashboard and deployment artifacts

- [x] 4.1 扩展管理后台仪表盘，展示依赖状态、队列、Judge、API 错误/延迟和风险告警，并使用现有轮询控制；用 UI 类型检查和构建验证
- [x] 4.2 增加 Prometheus scrape 配置、告警规则和 Grafana dashboard JSON，覆盖错误率、延迟、队列、结果积压、依赖、Judge、缓存和磁盘；用 YAML/JSON 解析和规则静态检查验证
- [x] 4.3 更新生产 Compose、配置模板、Nginx 探活和运维文档，说明指标端点内部访问、node_exporter/Alertmanager 接入和阈值；用 Compose config、文档链接检查和 Shell 测试验证
- [x] 4.4 增加可重复的观测检查/告警演练脚本，覆盖 live、ready、metrics、规则文件和通知链路前置条件；用无 Docker 的离线测试验证失败时返回非零

## 5. Integration verification and records

- [ ] 5.1 增加跨模块回归测试，验证 Judge 心跳、core 聚合、管理员快照和 readiness 的端到端契约；用项目约定的测试命令运行（本机 Docker daemon 未启动，待 CI/部署环境补跑）
- [x] 5.2 运行 `deno fmt`、`deno lint`、core 类型检查、`cargo fmt`、`cargo clippy`、相关测试和 `openspec validate --change production-observability --strict`，修复本变更引入的问题
- [x] 5.3 新增中文 Agent Note，记录指标低依赖实现、Redis TTL 心跳和外部通知解耦的决策；用 Agent Note 格式校验脚本验证
