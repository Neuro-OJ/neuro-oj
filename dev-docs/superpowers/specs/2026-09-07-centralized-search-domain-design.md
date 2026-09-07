# 中心化 Search Domain 设计文档

> 状态：设计已确认，待实现
> 日期：2026-09-07
> 范围：noj-core + noj-ui

## 1. 背景与目标

### 1.1 现状

当前 NOJ 已有全局搜索入口 `GET /api/v1/search`，由 `query` 域承载，覆盖题目、用户、社区帖子三类内容，基于 PostgreSQL tsvector + pg_trgm。但存在以下限制：

- 搜索范围有限：不包含社区评论、竞赛、提交记录、私信/消息、公告。
- 搜索逻辑分散在 `query` 域，各业务域与搜索索引没有清晰边界。
- 前端命令面板和完整页需要多次请求不同 `type`，体验不统一。
- 缺少统一索引表，后续扩展新实体类型成本高。

### 1.2 目标

建立一个**中心化 search domain**：

- 统一索引表 `search_entries`，聚合题目、用户、社区帖子、社区评论、竞赛、提交记录、私信/消息、公告。
- 源业务域不直接修改索引表，通过事件驱动方式通知 search domain 更新索引，实现高内聚低耦合。
- 搜索 API 支持混合分组与单类型分页，前端一个输入框即可搜索全部内容。
- 全量索引 + 行级权限过滤，敏感数据（私信、提交等）按业务权限动态过滤。
- 继续使用 PostgreSQL，不引入 Elasticsearch/Meilisearch 等外部搜索引擎。

### 1.3 非目标

- 不纳入 Neuro OJ Docs 文档站内容（后续可扩展）。
- 不引入 Outbox 强一致模式；采用“业务提交后发事件 + 消费端幂等 + 对账/重建兜底”的最终一致方案。
- 不做搜索建议/自动补全词库、高级搜索语法、搜索历史/个性化推荐。
- 提交记录不索引代码正文，只索引题目名、语言、状态等元数据。

## 2. 总体架构

```text
                    ┌─────────────────────────────────────────────┐
                    │                 noj-ui                     │
                    │   SearchPalette / /search 页               │
                    └───────────────┬─────────────────────────────┘
                                    │ GET /api/v1/search
                                    ▼
┌───────────────────────────────────────────────────────────────────┐
│                     noj-core  search domain                       │
│                                                                   │
│  routes/search.ts        services/search.ts                       │
│  middleware/search-rate-limit.ts                                  │
│  consumer/search-index-consumer.ts   ← 消费索引事件               │
│  services/index-writer.ts            ← 唯一写 search_entries     │
│  services/permission-filter.ts       ← 行级权限过滤               │
└───────┬───────────────────────────────────┬───────────────────────┘
        │ 读取源数据（只读）                  │ 写入
        ▼                                   ▼
┌───────────────┐                  ┌──────────────────┐
│ 各业务源表     │                  │ search_entries    │
│ problems/users │                  │ 统一索引表         │
│ community/...  │                  │ + GIN/trgm 索引    │
└───────┬───────┘                  └──────────────────┘
        │ 业务变更后发布事件
        ▼
┌──────────────────────────────────────────────────────┐
│ Redis MQ：noj:search:index                           │
│ 事件 = { entityType, entityId, action: upsert|delete }│
└──────────────────────────────────────────────────────┘
```

### 2.1 模块边界

- **新建 `search` domain**（`noj-core/src/domains/search/`）：
  - 唯一拥有 `search_entries` 表写权限。
  - 负责索引构建、权限过滤、搜索 API、限流、事件消费、回填/重建索引。
- **现有 `query` domain**：
  - 保留排行、统计、仪表盘等查询能力。
  - 把现有搜索相关代码迁移到新 `search` domain。
- **源 domain**（catalog / identity / community / contest / submission / messaging / system）：
  - 不直接读写 `search_entries`。
  - 在业务写操作成功后，向 `noj:search:index` 发布事件。
  - 事件只含 `{ entityType, entityId, action }`，不携带搜索正文。
- **依赖方向**：`search → 源域`（只读）；源域不依赖 search。

### 2.2 关键原则

1. 单一写者：`search_entries` 只有 search domain 能写。
2. 单向依赖：源域 → 事件；search 域 → 源域只读。
3. 可扩展：新增实体类型 = 新增 `entity_type` + 索引构建器 + 权限谓词。

## 3. 统一索引表结构

### 3.1 表定义

```sql
CREATE TABLE search_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     text NOT NULL,
  entity_id       text NOT NULL,
  title           text NOT NULL DEFAULT '',
  body            text NOT NULL DEFAULT '',
  search_vector   tsvector GENERATED ALWAYS AS (
                    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
                    setweight(to_tsvector('simple', coalesce(body, '')), 'B')
                  ) STORED,
  metadata        jsonb NOT NULL DEFAULT '{}',
  owner_id        text,
  participant_ids text[],
  is_public       boolean NOT NULL DEFAULT false,
  admin_only      boolean NOT NULL DEFAULT false,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      text NOT NULL,
  updated_at      text NOT NULL
);

CREATE UNIQUE INDEX idx_search_entries_entity
  ON search_entries (entity_type, entity_id);

CREATE INDEX idx_search_entries_vector
  ON search_entries USING GIN (search_vector);
CREATE INDEX idx_search_entries_title_trgm
  ON search_entries USING GIN (title gin_trgm_ops);
CREATE INDEX idx_search_entries_body_trgm
  ON search_entries USING GIN (body gin_trgm_ops);

CREATE INDEX idx_search_entries_owner
  ON search_entries (owner_id);
CREATE INDEX idx_search_entries_participants
  ON search_entries USING GIN (participant_ids);
CREATE INDEX idx_search_entries_public
  ON search_entries (is_public);
CREATE INDEX idx_search_entries_updated
  ON search_entries (updated_at);
```

### 3.2 实体映射

| entity_type | title | body | 关键权限元数据 |
|---|---|---|---|
| `problem` | 题目标题 | 题目描述 + 题号 + 标签名 | `is_public`（P 型公开）；U 型 `owner_id` |
| `user` | 用户名 | 邮箱 + 简介 | `admin_only=true` |
| `community_post` | 帖子标题 | 帖子正文 + 作者名 + 关联题号/题名 | `is_public`（published 才索引） |
| `community_comment` | 评论摘要 | 评论正文 + 作者名 + 所属帖子标题 | `is_public`（帖子 published 才索引） |
| `contest` | 竞赛名称 | 竞赛描述 + 关联题目名 | `is_public`；邀请/私有竞赛 `participant_ids` |
| `submission` | 题目名 + 提交者 | 语言 + 状态 + 题目名（不索引代码） | `owner_id` |
| `message` | 会话对方用户名 | 消息正文 + 双方用户名 | `participant_ids` |
| `announcement` | 公告标题 | 公告正文 | `is_public` 或 `admin_only` |

### 3.3 设计要点

- `search_vector` 由 PG 自动维护，应用层只读。
- `metadata` 存过滤/分面信息，如题目难度/题号/标签、帖子类型/题目、竞赛时间、提交状态、会话 ID 等。
- 提交记录不索引代码正文，避免搜索摘要泄露代码。
- 软删除/失效：源实体软删除时发 `upsert` 并带 `is_active=false`；硬删除时发 `delete` 移除索引行。
- 权限列独立出来，方便建索引和写过滤谓词。

## 4. 事件协议与索引更新流程

### 4.1 事件消息

队列：`noj:search:index`

```json
{
  "entityType": "problem",
  "entityId": "uuid-or-id",
  "action": "upsert",
  "occurredAt": "2026-09-07T12:00:00.000Z",
  "requestId": "optional-trace-id"
}
```

- `action`：`upsert` / `delete`。
- 消息不携带搜索正文，search domain 消费时自行读取源数据。

### 4.2 事件发布（源域侧）

- `shared/` 层提供 `publishSearchIndexEvent(entityType, entityId, action)`，封装 Redis LPUSH。
- 各源 domain 在业务写事务成功提交后调用。
- 发布失败不阻塞主流程，记录日志，由对账/重建兜底。

### 4.3 索引消费（search domain 侧）

```text
收到事件
  ├─ action = upsert
  │    ├─ 从源域只读接口/源表读取最新数据
  │    ├─ 源不存在 → 删除 search_entries 中对应行（幂等）
  │    └─ 源存在 → 构建索引行并 UPSERT
  └─ action = delete
       ├─ 先检查源是否仍存在
       ├─ 源仍存在 → 视为 upsert（防止乱序 delete 误删）
       └─ 源不存在/已软删 → 删除或标记 is_active=false
```

- 幂等性：UPSERT 依赖唯一键 `(entity_type, entity_id)`；delete 天然幂等。
- 失败重试：指数退避 1s→2s→4s→…→30s 封顶；超过上限进入死信日志。
- 乱序防护：消费时以源表最新状态为准。

### 4.4 回填与对账

- CLI：`deno task search:reindex` 全量扫描源表重建 `search_entries`。
- 可选每日对账任务：对比源表与 `search_entries` 计数/抽样，发现漂移后局部重建。

### 4.5 一致性

- 正常路径：业务写入后秒级内索引可见（最终一致）。
- 异常路径：事件丢失由 `search:reindex` 或对账任务兜底。
- 不保证实时强一致，但保证“源表为准、最终收敛”。

## 5. 搜索 API 与权限过滤

### 5.1 API

`GET /api/v1/search`

**命令面板模式（grouped）：**

```
GET /api/v1/search?q=动态&types=problem,user,community_post,community_comment,contest,submission,message,announcement&per_type=5
```

```json
{
  "data": {
    "query": "动态",
    "mode": "grouped",
    "groups": {
      "problem": { "items": [], "has_more": true },
      "user": { "items": [], "has_more": false },
      "community_post": { "items": [], "has_more": false }
    },
    "took_ms": 42
  }
}
```

**完整结果页模式（flat）：**

```
GET /api/v1/search?q=动态&type=problem&page=1&per_page=20
```

或“全部”Tab 不传 `type`：

```json
{
  "data": {
    "query": "动态",
    "mode": "flat",
    "items": [
      {
        "entity_type": "problem",
        "entity_id": "...",
        "title": "...",
        "highlight": "...",
        "rank": 0.12,
        "metadata": { "display_id": "P1001", "difficulty": "medium" }
      }
    ],
    "has_more": true,
    "page": 1,
    "per_page": 20,
    "took_ms": 42
  }
}
```

- 统一条目结构：`entity_type` + `entity_id` + `title` + `highlight` + `rank` + `metadata`。
- 保留 `X-Search-Took-Ms` 响应头。
- 参数默认值：`types` 缺省时返回全部可搜索类型；`per_type` 缺省为 5；`per_page` 缺省为 20，最大 50。

### 5.2 权限过滤

统一权限谓词：

```sql
WHERE (
  is_public = true
  OR owner_id = :userId
  OR :userId = ANY(participant_ids)
  OR :isAdmin = true
)
AND (admin_only = false OR :isAdmin = true)
```

| entity_type | 匿名 | 登录普通用户 | admin |
|---|---|---|---|
| `problem` | 公开 P 型 | 公开 P 型 + 自己的 U 型 | 全部 |
| `user` | ❌ | ❌ | ✅（`admin_only=true`） |
| `community_post/comment` | 按 `guest_read_enabled` 配置 | 公开帖子/评论 | 全部 |
| `contest` | 公开竞赛 | 公开 + 已参与的邀请/私有竞赛 | 全部 |
| `submission` | ❌ | 自己的提交 | 全部 |
| `message` | ❌ | 会话参与者 | 全部 |
| `announcement` | 公开公告 | 公开公告 | 全部（含仅管理员公告） |

- 权限过滤集中在 search domain。
- `admin_only` 只用于“仅管理员可见”的实体（用户搜索、仅管理员公告）。
- 社区访客配置：`guest_read_enabled=false` 时匿名请求排除 community 类型。
- 限流沿用现有 `searchRateLimit`。

## 6. 前端体验改造

### 6.1 `useSearch` composable

- 状态：`query`、`loading`、`error`、`mode`、`groups`、`flatItems`、`hasMore`、`page`、`selectedType`。
- 命令面板：请求 grouped 模式。
- 完整页“全部”：请求 flat 混合结果，前端按 `entity_type` 分组展示。
- 完整页具体类型：请求 `type=xxx&page=N&per_page=20`。
- 保留防抖 300ms、`requestSeq` 竞态防护、`onScopeDispose` 清理。

### 6.2 SearchPalette

- 一个输入框，结果按类型分组展示。
- 每组最多 `per_type` 条（默认 5）。
- 键盘导航在扁平列表上统一进行。
- 底部“查看全部结果 →”跳转 `/search?q=...&type=all`。
- 空组自动隐藏。

### 6.3 `/search` 完整结果页

- 类型 Tab：`全部 / 题目 / 用户 / 帖子 / 评论 / 竞赛 / 提交 / 消息 / 公告`。
- “全部”Tab：混合分组展示，每组前 N 条 + “更多”跳转对应类型 Tab。
- 具体类型 Tab：flat 分页列表。
- URL 同步：`?q=&type=&page=`。
- 继续使用 `AsyncContent` 状态机。

### 6.4 SearchResultItem 通用化

- 根据 `entity_type` 渲染图标/徽章、主标题、副信息。
- 高亮继续用 `[[HIGHLIGHT]]` 安全分段渲染，不用 `v-html`。
- 跳转链接按类型映射到对应页面。

### 6.5 导航入口

- Navbar 搜索按钮 + `Ctrl+K` 保持不变。
- placeholder 更新为“搜索题目、用户、帖子、竞赛、提交、消息、公告...”。

## 7. 错误处理、一致性、可观测性

### 7.1 错误处理

**搜索 API：**

| 场景 | HTTP | code |
|---|---|---|
| `q` 缺失 / 长度 <2 / >100 | 400 | `VALIDATION_ERROR` |
| `types` / `type` 非法 | 400 | `VALIDATION_ERROR` |
| `page` / `per_page` 越界 | 400 | `VALIDATION_ERROR` |
| 未登录访问仅登录内容 | 401 | `UNAUTHORIZED` |
| 无权限访问 admin_only / 他人数据 | 403 | `FORBIDDEN` |
| 触发限流 | 429 | `RATE_LIMITED` |
| 数据库错误 | 500 | `INTERNAL_ERROR` + `request_id` |

**索引消费：**

- 失败重试：指数退避 1s→2s→4s→…→30s 封顶。
- 超过上限：写入死信日志，不阻塞后续消息。
- 源域发事件失败：只记录日志，不阻塞业务主流程。

### 7.2 一致性

- 最终一致，秒级延迟。
- 消费端幂等。
- 乱序防护。
- 自愈：`search:reindex` + 可选每日对账。
- 不引入 Outbox。

### 7.3 可观测性

- 指标：搜索耗时、QPS、按类型分布、索引队列深度、消费速率/失败数/死信数、索引滞后、reindex 进度。
- 日志：搜索请求 `q` 脱敏/截断；索引事件记录元数据不记录正文；消费失败/死信记录错误。
- 健康检查：search 消费者存活、队列积压告警。

## 8. 测试策略与迁移部署

### 8.1 测试策略

**单元测试：**
- `index-writer`：upsert/delete、幂等、源不存在、乱序 delete。
- `permission-filter`：匿名/普通用户/admin 可见性矩阵。
- `event-consumer`：正常消费、失败重试、死信。
- 工具函数：`escapeLikePattern`、事件解析。

**路由/集成测试：**
- grouped / flat 模式。
- 参数校验、权限矩阵、限流。
- 事件发布后索引可见。

**前端 E2E：**
- 命令面板分组展示、键盘导航、跳转。
- `/search` 页“全部”分组、具体类型分页、URL 同步。
- 高亮安全渲染。

**性能测试：**
- 小规模（各表 <10 万行）下 grouped / flat 搜索响应 < 500ms。

### 8.2 迁移与部署

**数据库迁移：**
- 新增 `search_entries` 表 + 索引（一个 Drizzle 迁移文件）。

**代码迁移：**
- 新建 `search` domain，迁移 `query` 域搜索代码。
- 各源 domain 接入事件发布。
- `main.ts` 启动 search 消费者。

**上线顺序：**
1. 数据库迁移。
2. 部署 noj-core（search domain + 消费者 + 事件发布）。
3. 运行 `deno task search:reindex` 全量回填。
4. 验证搜索 API 与权限过滤。
5. 部署 noj-ui 前端。
6. 观察索引队列、消费延迟、搜索耗时。

**回滚方案：**
- 前端回退旧版。
- 后端停用 search 消费者，搜索 API 降级或 503。
- `search_entries` 表保留不删，回滚不影响源业务表。

## 9. 后续可扩展

- 纳入 Neuro OJ Docs 文档站内容。
- 升级为 Outbox 强一致模式。
- 搜索建议/自动补全。
- 高级搜索语法。
- 搜索历史/个性化推荐。
- 提交代码内容搜索（需额外安全评估）。
