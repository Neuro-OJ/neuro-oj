# Neuro OJ 系统架构评审（2026-09-01）

> 状态：评审结论 / 建议草案
> 基线：当前工作区 HEAD `c6bf20d42`
> 范围：全栈架构 + 可维护性 + 安全与可靠性
> 方法：静态阅读 + 与 `dev-docs/audit/2026-08-15-noj-audit/` 交叉核对，重点确认高危项是否已在当前代码修复

---

## 1. 总体结论

Neuro OJ 已从“MVP + 高危审计整改”阶段走向“工程化”阶段，不需要推倒重来。

当前四模块拓扑（`noj-ui` / `noj-core` / `noj-judge` / `noj-llm-gateway`）方向正确，且近期已修复大量 8 月审计中的严重/高危问题。目前主要矛盾已从“致命漏洞”转向“规模增长后的模块边界、可维护性、可观测性与水平扩展”。

---

## 2. 已确认改善的关键点

以下问题在 8 月审计报告中为高危/严重，当前代码中已看到修复：

| 问题 | 当前状态 |
|---|---|
| 搜索高亮 `v-html` 存储型 XSS（NOJ-248） | 已改为纯文本分段 + 受控 `<mark>` 渲染，不再使用 `v-html` |
| 本地/S3 存储路径穿越与越权（NOJ-061/115/116） | local 增加 `validateStorageKey` + 根目录约束；S3 get/delete 增加 provider 与 key 校验 |
| JWT 算法混淆（NOJ-000） | `verifyToken` 已显式 `algorithms: ["HS256"]` |
| `X-Real-IP` 无条件信任（NOJ-091） | 已仅在直连对端命中可信代理时采用 `X-Real-IP` |
| 生产 `TRUSTED_PROXIES` 校验时序（NOJ-031） | 已移到系统设置缓存初始化之后 |
| MQ at-most-once 丢任务/丢结果（NOJ-179/066/074） | 已改为 `BRPOPLPUSH` + `processing` + `sweeper` + 死信队列 |
| 批量重测 `rejudge_seq` 覆盖（NOJ-075） | 已逐行读取各自 `rejudge_seq` 透传 |
| judge 成功路径丢失 `rejudge_seq`（NOJ-161） | `build_judge_result` 已接收并透传 `rejudge_seq` |
| judge BRPOP 丢任务（NOJ-179） | 已改用 `BRPOPLPUSH`，并增加 `ack_task` |
| 注册/密码重置/私信无限流（NOJ-093/094/096） | 已补充 hardening rate-limit |
| core/judge 无优雅关闭（NOJ-030/152） | 已监听 SIGTERM/SIGINT，core 有 `server.shutdown()` |
| 搜索分页参数 `limit`/`per_page` 不一致（NOJ-225） | 前端已改用 `per_page` |
| `useApi` 401 僵尸登录态（NOJ-210） | 已清理 `auth:user`、session cookie 并调用 logout |

---

## 3. 仍需关注的结构性问题

### 3.1 noj-core 单体重服务持续膨胀

- 现状：50 张表、约 3.7 万行 TypeScript；`src/db/schema.ts` 1672 行。
- 承载域：auth/RBAC、题目、提交、评测队列、竞赛、社区、私信、客观题、题单、搜索、统计、审计、LLM 管理客户端。
- 影响：
  - 发布面大，任一域改动需全量回归；
  - 水平扩展只能整体扩副本，无法按热点域独立扩；
  - 跨域直接读表容易让权限/数据边界模糊。

建议：
1. 不急于拆微服务；
2. 先固化域边界：`community/`、`contest/`、`objective/`、`trainings/` 等目录级拆分继续收敛依赖；
3. 路由层只依赖 service 接口，业务域不跨域直接读表；
4. 为未来可选独立部署保留 seam。

### 3.2 core 与 llm-gateway 共享 PostgreSQL schema，数据所有权不清

- `llm_providers` / `llm_usage` / `llm_quotas` 定义在 `noj-core/src/db/schema.ts`，但主要读写发生在 `noj-llm-gateway`。
- 两边连接同一个 Postgres，gateway 没有自己的迁移所有权。
- 影响：llm-gateway 无法独立演进/扩容；core 迁移会牵连 llm 表；职责边界模糊。

建议：
1. 明确 llm 域数据归 llm-gateway 所有；
2. 迁移与 schema 定义迁移到 gateway 侧，或使用独立 schema/命名空间；
3. core 只通过 `/internal/*` 或网关 API 访问 llm 能力，不直接触表。

### 3.3 Redis List MQ 仍是“自制可靠队列”

- 已解决消息丢失，但仍是应用层实现的 `List + processing + sweeper`。
- 缺少：consumer group、分区、优先级、消息轨迹、独立监控界面。
- 队列监控/管理偏手工，`LRANGE` 全量拉取在高积压时有风险。

建议：
1. 短期：补齐队列指标（长度、processing 年龄、dead 数量、重投次数），监控接口分页；
2. 中期：评估 `Redis Streams + Consumer Group` 或专用 MQ（RabbitMQ/NATS）；
3. 至少加入优先级队列与背压/拒流策略。

### 3.4 SSE 事件不是强事务 Outbox

- `publishSseEvent` 是“业务写库成功后，再写 `sse_events`”，后者失败仅记日志。
- 如果业务成功但事件丢失，客户端只能靠轮询补偿。

建议：
1. 对关键通知（评测结果、竞赛排名、私信、公告）引入事务性 outbox；
2. 同一事务写业务 + `sse_events`；
3. 由后台任务投递到 Redis Pub/Sub；
4. 已有 `sse_events` 表，升级成本较低。

---

## 4. 可维护性问题

### 4.1 巨型文件仍存在

- `noj-core/src/db/schema.ts`：1672 行；
- `noj-judge/src/dual/mod.rs`：1662 行；
- `noj-core/src/db/connection.ts`：672 行。

建议：
- schema 按域拆成多个文件（auth、problem、submission、community、contest、llm、system…）再聚合导出；
- judge `dual/mod.rs` 按“状态机 / 协议解析 / 容器编排”拆分；
- 继续执行 `dev-docs/superpowers/plans/2026-08-28-engineering-quality-roadmap.md` 中的代码质量治理。

### 4.2 前端测试与工程化仍是短板

- 目前仍无前端单元测试；
- composable 命名有 camelCase 与 kebab-case 混用；
- 审计中很多 UI 层问题已修，但“直接 `$fetch`、401 僵尸态、请求竞态”这类问题容易复发。

建议：
- 按路线图补 Vitest + 关键 composables 覆盖；
- 统一 composable 命名规范；
- 把 noj-ui 的“已知限制”转成可追踪 issue，而不是留在文档里。

### 4.3 架构文档过于简略

- `noj-docs/docs/system/architecture.md` 仅有 13 行，缺少多实例拓扑、队列可靠性模型、事件流、数据所有权、部署拓扑。

建议：
- 补“现状架构”和“目标架构”两张图；
- 把关键决策记入 `.agents/notes/`。

---

## 5. 安全与可靠性补强

### 5.1 限流已大量补齐，但需“系统性清单”

- 已确认注册、密码重置、私信等端点有限流。
- 提交、竞赛操作、社区发帖、管理接口仍建议统一梳理成“写操作限流矩阵”，防止新端点漏加。

### 5.2 评测沙箱纵深防御仍需闭环

- 已看到 rootless Docker、非 root judge、CPU/内存限制、镜像前缀等。
- 仍需核对/落实：
  - 基础镜像固定 digest；
  - zip 解压“实时字节上限”而非仅信任声明大小；
  - 孤儿容器启动清扫；
  - CPU 上限、内存封顶等是否已全面覆盖。

### 5.3 可观测性仍是最大空白

- 有结构化日志、审计日志，但没有 Prometheus metrics / tracing。
- 队列深度、消费者活跃度、SSE 重放、评测耗时、LLM 调用成本缺少大盘。

建议：
- 先给 core/judge/gateway 暴露 `/metrics`；
- 用 `request_id` / `submission_id` 串起日志、指标、审计；
- 再接入告警（队列积压、消费者掉线、judge 异常退出）。

---

## 6. 建议演进路线

| 阶段 | 重点 |
|---|---|
| 短期 1-2 迭代 | 完成工程质量路线图 Phase 0/1：CI 门禁、覆盖率、前端测试、文档治理；明确 llm 域数据归属 |
| 中期 Phase 2 | 拆分 llm schema 所有权；引入 Redis Streams 或强化队列可观测；关键事件 Outbox；judge 安全加固清单闭环 |
| 长期 | 按域将 community/contest/llm 等逐步可选独立部署；多 judge worker + 队列分区；K8s 化与自动扩缩容；监控告警体系 |

---

## 7. 下一步候选主题

如果继续落地，建议从以下高价值项中选一个开展 architectural 设计：

1. LLM 域数据所有权分离；
2. 关键事件 Outbox + 队列可观测性；
3. noj-core 领域模块边界固化。

每个主题可继续走 `brainstorming → writing-plans` 流程产出正式 spec 与实施计划。
