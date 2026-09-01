# Neuro OJ 工程质量提升路线图设计

- 日期：2026-08-28
- 状态：已与需求方确认方向，待审阅
- 范围：noj-core / noj-ui / noj-judge / noj-llm-gateway 的工程质量治理，含文档、注释、测试/CI、架构演进与 SSE 事件日志专项

## 背景

NOJ 当前工程质量主要依赖个人习惯，缺少系统性护栏：

- 文档数量不少，但存在漂移（8 月审计 28 条 docs 真阳性），根 `AGENTS.md` 过载。
- 注释覆盖率不均（noj-ui 导出 JSDoc 约 52%），且无强制门禁，已有注释与实现不一致案例。
- 测试分层已有基础，但缺少集中 gate runner、覆盖率门禁、真实入口 smoke 和 LLM 回放测试。
- SSE 使用 Redis Pub/Sub fire-and-forget，事件不持久、不可重放，存在“订阅前丢事件”竞态；queue/stats/announcements/user 等频道同样无历史。
- 架构上已有 StorageProvider 等雏形，但未系统化“接口/实现/消费者”分层，事件域也未明确“事实 vs 投影”。

参考 deepseek-harness 的可借鉴点：capability seam、事件域分离、决策记录、文档分层与门禁、测试分层、注释/导出 JSDoc 门禁。

## 目标

1. 文档/注释不漂移：非平凡变更必须同步文档；文档链接、导出 JSDoc 由 CI 检查。
2. 测试能抓住真问题：真实入口 smoke、LLM 回放、关键覆盖率门禁。
3. 架构可替换：核心能力有清晰 seam，新增 provider 不改业务代码。
4. 决策可追溯：每次非平凡改动留下 `Problem / Decision / Alternatives / Consequences` 记录。
5. SSE 状态不丢：所有事件频道持久化到 PostgreSQL，支持全局 seq 重放与断线续传。

## 非目标

- 不引入 Cordis 插件微内核。
- 不做每文件 100% 覆盖率。
- 不做中英双语 i18n 配对。
- 不做 Redis Stream 加速层（第一版 SSE 历史直接存 PostgreSQL）。
- 不为了“像 deepseek-harness”而重构。

## 总体方案

采用三阶段混合路线：

| 阶段 | 主题 | 周期 |
|---|---|---|
| Phase 0 | 止血与护栏：文档/注释/决策记录/本地快检 | 2–4 周 |
| Phase 1 | 测试与 CI 加固：gate runner/覆盖率/真实入口/类型安全 | 4–8 周 |
| Phase 2 | 架构演进：capability seam/事件域/SSE 事件日志/配置分层 | 2–3 个月 |
| Phase 3 | 固化与持续改进：PR 清单/月度审计/postmortem | 持续 |

### Phase 0：止血与护栏

| 任务 | 内容 | 验收 |
|---|---|---|
| 0.1 决策记录 | 新增 `.agents/notes/implemented/`，模板固定为 `Problem / Decision / Alternatives considered / Consequences`；非平凡 PR 必须带一条 | 有格式校验脚本；首批记录落地 |
| 0.2 注释门禁 | 新增 `scripts/verify-export-jsdoc.ts`，先对 noj-core、noj-llm-gateway 强制导出符号有 `/** */` | CI 新增 job；未注释导出失败 |
| 0.3 文档链接门禁 | 新增 `verify-md-links`，检查仓库内相对链接与锚点 | CI 失败于死链/坏锚点 |
| 0.4 根文档瘦身 | 根 `AGENTS.md` 压缩为“规则 + 链接”，详细内容下沉 | 根文档减少至少 40% |
| 0.5 工程文档 | 新增 `dev-docs/engineering/testing.md`、`dev-docs/engineering/defensive-patterns.md`、`dev-docs/engineering/development.md` | 与现状一致并链接到 AGENTS |
| 0.6 清理漂移 | 修复 8 月审计 docs 真阳性与已知注释-实现不一致 | 审计清单关闭 |
| 0.7 本地快检 | lefthook：pre-commit staged lint/fmt/whitespace，pre-push typecheck | 本地提交前快检完成 |

### Phase 1：测试与 CI 加固

| 任务 | 内容 | 验收 |
|---|---|---|
| 1.1 集中 Gate Runner | 新增 `scripts/check-all.ts` / `check-ci.ts` 统一入口 | 一条命令跑完相关检查 |
| 1.2 覆盖率门禁 | noj-core ≥ 75%、noj-judge ≥ 80%、noj-llm-gateway ≥ 80%、noj-ui 关键 composables ≥ 60% | CI coverage job 低于阈值失败 |
| 1.3 真实入口 Smoke | judge built binary / Docker 镜像 smoke；core `deno compile` smoke | 发布物入口被测试覆盖 |
| 1.4 LLM 回放测试 | noj-llm-gateway 增加录制-回放快照 | `test:snapshot` 可用 |
| 1.5 with-key E2E 自跳 | 真实 API 测试用 key 守卫 self-skip | 无 key CI 绿，有 key 真实验证 |
| 1.6 防御模式测试 | 超时+exit0、cleanup quiescence、ZIP 穿越、env scrub 等回归测试 | 每个模式至少一个测试 |
| 1.7 类型安全 | JudgeTask/JudgeResult/SubmissionStatus 改 tagged union + assertNever；跨边界 ID 品牌化 | 新增状态/事件编译期强制覆盖 |

### Phase 2：架构演进

| 任务 | 内容 | 验收 |
|---|---|---|
| 2.1 Capability Seam | Storage / LLM Provider / Email Provider / Search 统一为“接口 + 实现 + 消费者” | 新增 provider 不改消费者 |
| 2.2 事件域分离 | DB/事件流为事实，SSE/event-bus 为投影；提交生命周期以 DB/事件为准 | 无第二份真相 |
| 2.3 SSE 事件日志 | 所有 SSE 频道持久化到 PostgreSQL，全局 seq 可重放（见下） | 断线续传、不丢事件 |
| 2.4 可重放审计日志 | LLM 网关/评测链路记录完整请求/响应/工具调用 | 模型可见内容可从日志重建 |
| 2.5 配置分层 | dev/e2e/prod 配置抽象为 profile + overlay | 三套环境配置不漂移 |
| 2.6 生成式 Catalog | 路由/事件/配置表从源码生成 | 文档与源码自动一致 |

### Phase 3：固化与持续改进

- PR 检查清单：文档同步、注释契约、测试覆盖、决策记录、GPG/Conventional Commits。
- 月度质量审计：复用 8 月审计方法，扫描 dev-docs/comment/coverage。
- Postmortem 制度：严重事故写一页事实/根因/防复发。
- 门禁迭代：根据误报率调整规则，避免形式主义。

## SSE 事件日志详细设计

### 现状

- 事件总线：Redis Pub/Sub，`publishEvent` fire-and-forget。
- SSE 只发“触发通知”，客户端收到后重新拉 REST。
- 频道：submission、queue、stats、announcements、user、contest ranking、contest submission。
- 无持久化、无 seq、无重放；存在“连接后、订阅前”丢事件竞态。

### 目标

- 所有 SSE 频道的事件进入 PostgreSQL，统一全局单调 seq。
- SSE 连接可携带 `Last-Event-ID` 重放缺失事件。
- 事件负载携带 seq 与状态快照，客户端可直接更新本地状态。
- 不做 Redis Stream 加速。

### 数据模型

新增通用事件表：

```sql
CREATE TABLE sse_events (
  id         BIGSERIAL PRIMARY KEY,          -- 全局单调 seq
  channel    TEXT NOT NULL,                  -- 频道名，如 submission:<id>、queue、stats
  payload    JSONB NOT NULL,                 -- 事件内容
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sse_events_channel_id ON sse_events (channel, id);
CREATE INDEX idx_sse_events_id ON sse_events (id);
```

`id` 即 SSE 的全局 `Last-Event-ID`。多频道连接（如 contest 同时订阅 ranking + submission）用同一个全局游标即可。

### 写入与发布流程

事件在“状态变更/业务动作发生处”写入 PG，再发布 Redis：

```text
1. 业务代码在事务内更新状态（如 updateSubmissionStatus）；
2. 同一事务插入 sse_events（channel + payload）；
3. 提交后调用 publishEvent 发布 Redis 通知，payload 中带事件 id；
4. Redis Pub/Sub 继续负责多实例/多客户端实时扇出。
```

对于不涉及 DB 事务的事件（如 stats 刷新），先插入 `sse_events` 拿到 id，再发布 Redis。

### SSE 连接与重放流程

每个 SSE 连接按以下顺序避免竞态：

```text
1. 客户端连接，携带 Last-Event-ID（可为空）；
2. 服务端先注册 Redis 本地订阅回调（保证新事件不丢）；
3. 查询当前快照（如 submission 当前状态）并推送 snapshot；
4. 查询 sse_events WHERE id > lastEventId AND channel = ANY(当前连接频道) ORDER BY id；
5. 逐条推送缺失事件；
6. 之后由 Redis 订阅回调实时推送新事件。
```

若客户端未带 `Last-Event-ID`：
- 对 submission：以快照查询时的最大事件 id 作为游标，再执行步骤 4，补上快照之后可能已发生的事件；
- 对 queue/stats 等：直接推当前快照，再补最近事件。

### 频道清单

| 频道 | 事件示例 | 是否持久化 |
|---|---|---|
| `submission:<id>` | `submission:updated` | 是 |
| `queue` | `queue:changed` | 是 |
| `stats` | `stats:updated` | 是 |
| `announcements` | `announcements:updated` | 是 |
| `user:<id>` | `notification:new`、`message:new` | 是 |
| `contest:<id>:ranking` | `contest:ranking:updated` | 是 |
| `contest:<id>:submission` | `contest:submission:created` | 是 |

### 保留策略

- 默认保留 7 天，或按频道保留最近 N 条（如 submission 保留最近 200 条）。
- 新增定时清理任务，删除 `created_at < now() - interval '7 days'` 的旧事件。
- 清理任务不影响实时推送；重放只对保留期内事件负责，超期后客户端以 REST 全量校准。

### 客户端升级

`useEventSource` 升级：

```ts
{
  state,          // connecting | connected | fallback | disabled
  lastEventId,    // 最近收到的全局 seq，重连时回传
  retryCount,     // 连续失败次数
  reconnect,      // 手动重连
}
```

- 重连时自动带 `Last-Event-ID`。
- 指数退避：1s → 2s → 4s → 30s 封顶。
- 提交详情页 `EditorWorkspace` 从纯轮询改为“SSE + fallback 轮询”，终态自动停止。
- 事件按 `id` 去重，丢弃旧事件。

### SSE 事件协议类型

在 core/ui 之间定义共享类型：

```ts
interface SseEventMap {
  'submission:updated': { seq: number; id: string; status: SubmissionStatus; score?: number };
  'queue:changed': { seq: number; type: 'queue:changed' };
  'stats:updated': { seq: number; total: Stats; today: Stats };
  'announcements:updated': { seq: number };
  'notification:new': { seq: number; notification: Notification };
  'message:new': { seq: number; conversationId: string };
  // contest 事件...
}
```

新增事件时编译期强制覆盖。

### 测试

- SSE 端点重放：连接时带 `Last-Event-ID`，能收到缺失事件。
- 竞态测试：先订阅后变终态、先变终态后订阅，均不丢事件。
- 多频道连接：contest 同时订阅 ranking + submission，使用全局游标正确补发。
- 客户端去重：重复事件按 `seq` 忽略。
- 保留策略：超期事件被清理，客户端回退 REST 校准。
- 提交详情页：SSE 不可用时降级轮询，终态自动停止。

## 验收标准

1. 文档链接、导出 JSDoc、决策记录格式均有 CI 门禁。
2. 覆盖率门禁按模块生效。
3. 所有 SSE 频道事件写入 `sse_events`，支持全局 seq 重放。
4. SSE 断线重连不丢事件，客户端按 seq 去重。
5. 提交详情页不再纯轮询，SSE 不可用时降级。
6. 非平凡 PR 默认带决策记录与文档同步。

## 风险与取舍

- PG 写入增加：每次 SSE 事件多一次 INSERT。事件负载小、有索引，先接受；若成为热点再考虑批量或异步写入。
- 事件表增长：靠保留策略控制，需定时清理任务。
- 改造面较大：SSE 涉及 core、ui、测试三端，建议按“表结构 → 服务端写入/重放 → 客户端升级 → 页面切换”顺序推进。
- 注释门禁可能误报：先对 noj-core/llm-gateway 强制，UI 分阶段，允许人工豁免注释。

## 相关文档

- `AGENTS.md`：现状、安全模型、测试约定
- `dev-docs/audit/2026-08-15-noj-audit/docs.md`：文档漂移清单
- `noj-core/src/lib/event-bus.ts`、`noj-core/src/lib/sse-stream.ts`、`noj-core/src/routes/sse.ts`：SSE 现状
- `noj-ui/composables/useEventSource.ts`、`useSubmissionPolling.ts`：客户端现状
