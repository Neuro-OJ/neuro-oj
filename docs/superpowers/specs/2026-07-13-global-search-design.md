# 全局搜索（题目 + 用户） — 设计文档

> Issue: https://github.com/Neuro-OJ/neuro-oj/issues/100
> 里程碑: Phase 1.5: Production Readiness
> 作者: chenmou2012
> 日期: 2026-07-13

## 1. 背景与目标

### 1.1 问题

当前 NOJ 缺乏统一的全文搜索能力：

- **题目列表**（`GET /api/v1/problems`）仅支持 `keyword` 参数做 `ILIKE` 模糊匹配（性能差、无相关性排序、无中文友好分词），且默认只显示 P 型题。
- **用户搜索**仅私信场景的 `/api/v1/users/search` 端点，使用 `ILIKE` 模糊匹配 username，admin 无按 email 搜索用户的能力。
- 用户反馈"找一个做过的题目只能凭记忆翻列表"。

### 1.2 目标

实现全局搜索能力，覆盖：

- **题目**：按 `title` 和 `display_id`（如 `P1001`/`U42`）搜索
- **用户**：按 `username` 和 `email` 搜索（仅 admin）

### 1.3 非目标（YAGNI）

- **不做**：题目 description 全文搜索（验收标准只列了 title + display_id）
- **不做**：搜索建议（autocomplete 单独 word bank）
- **不做**：高级搜索语法（如 `tag:difficulty=easy`）
- **不做**：搜索结果缓存层（GIN 索引足够快，不引入 Redis cache 复杂度）
- **不做**：搜索历史 / 个性化推荐
- **不做**：跨语言支持（zhparser 等外部字典）

### 1.4 验收标准（来自 issue #100）

- [x] problems 表添加 tsvector 列 + GIN 索引（通过迁移）
- [x] 题目创建/更新时自动更新 tsvector
- [x] 搜索 API 返回分页结果，含中文分词支持（pg_trgm 或简单分词）
- [x] 前端导航栏新增搜索框（快捷键 Ctrl+K）
- [x] 搜索结果页：题目 → 跳转题目页，用户 → 跳转用户主页（admin 可见）
- [x] 搜索性能：10 万题 + 1 万用户时响应 < 500ms

---

## 2. 架构总览

```
+-----------------+          Ctrl+K 命令面板
|   noj-ui        | <------> (SearchPalette.vue)
|  (Vue 3 + Nuxt) |    fetch /api/v1/search?q=...
+--------+--------+
         |  Nitro 代理
         v
+-----------------+    限流（Redis）              +---------+
|   noj-core      | <--------------------------> |  Redis  |
| (Deno + Hono)   |    ratelimit:search:ip:<ip>  +---------+
|                 |
| routes/search.ts| ----+
| services/       |     |
|   search.ts     |     |    SQL: tsvector @@ websearch_to_tsquery
|                 |     |          OR trigram 模糊匹配 (pg_trgm)
+--------+--------+     |
         |              v
         |       +-----------------+      +-------------------+
         +-----> |  PostgreSQL 16  |      | problems          |
                 |  + pg_trgm ext  |      |  + search_vector  |
                 |                 |      |  + GIN(tsvector)  |
                 |                 |      |  + GIN(trgm)      |
                 |                 |      | users             |
                 |                 |      |  + search_vector  |
                 |                 |      |  + GIN(tsvector)  |
                 |                 |      |  + GIN(trgm)      |
                 +-----------------+      +-------------------+
```

---

## 3. 数据库设计

### 3.1 迁移文件

新文件 `noj-core/drizzle/0017_search_indexes.sql`，由 Drizzle Kit 自动生成 + 手工调整 tsvector 表达式和 GENERATED 列语法。

```sql
-- 启用 pg_trgm 扩展（处理中文模糊匹配）
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- problems 加 search_vector 列（GENERATED 列由 PG 自动维护）
ALTER TABLE problems
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple',
      coalesce(type, '') || ' ' || coalesce(number::text, '')
    ), 'B')
  ) STORED;

-- problems tsvector GIN 索引（精确匹配）
CREATE INDEX idx_problems_search_vector ON problems USING GIN (search_vector);

-- problems trigram GIN 索引（中文模糊匹配）
CREATE INDEX idx_problems_title_trgm ON problems USING GIN (title gin_trgm_ops);

-- users 加 search_vector 列
ALTER TABLE users
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(username, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(email, '')), 'B')
  ) STORED;

-- users tsvector GIN 索引
CREATE INDEX idx_users_search_vector ON users USING GIN (search_vector);

-- users trigram GIN 索引
CREATE INDEX idx_users_username_trgm ON users USING GIN (username gin_trgm_ops);
```

### 3.2 设计要点

**为什么用 GENERATED 列而非触发器**：

- PostgreSQL 12+ 的 `GENERATED ALWAYS AS ... STORED` 由存储引擎保证在 INSERT/UPDATE 时自动重算
- 不依赖触发器定义正确性、不受 `ALTER TABLE ... DISABLE TRIGGER` 影响
- Drizzle ORM 可直接 `select` 但**不能**写入（写入由 PG 自动维护）—— schema 中标记 `generatedAlwaysAs()`

**权重设计**：

| 字段 | 权重 | 说明 |
|------|------|------|
| `title` | A (1.0) | 最高相关性 |
| `display_id` (P1001/U42) | B (0.4) | 题号精确匹配 |
| `username` | A (1.0) | 用户名匹配最重要 |
| `email` | B (0.4) | 邮箱次要 |

`ts_rank` 自动按权重计算相关性分数。

**为什么同时建 tsvector 和 trigram 两个 GIN 索引**：

- tsvector 对 `simple` 配置 + 英文/数字分词效果极好（"P1001"、"Hello" 直接命中）
- tsvector 对中文按字切分，召回率低
- pg_trgm 对任意子串（含中文）做 trigram 匹配，召回率高
- 两个索引联合 `OR` 查询，由 PG planner 自动选择最优路径
- 性能预算：10 万题场景，GIN tsvector < 50ms，GIN trgm < 200ms

**索引体积估算**：

- 100k 题目 × 平均 title 50 字符 → tsvector GIN ~80MB
- 100k 题目 × title trigram GIN ~120MB
- 10k 用户 × username/email trigram GIN ~20MB
- 总计 ~220MB，可接受

### 3.3 Schema 改动

`noj-core/src/db/schema.ts` 中：

```typescript
export const problems = pgTable(
  "problems",
  {
    // ... 现有字段
    /** tsvector 列，GENERATED 自动维护，不可写入 */
    searchVector: tsvector("search_vector"),
  },
  (table) => ({
    // ... 现有索引
    searchVectorIdx: index("idx_problems_search_vector").using(
      "gin",
      table.searchVector,
    ),
  }),
);

export const users = pgTable(
  "users",
  {
    // ... 现有字段
    /** tsvector 列，GENERATED 自动维护，不可写入 */
    searchVector: tsvector("search_vector"),
  },
  (table) => ({
    // ... 现有索引
    searchVectorIdx: index("idx_users_search_vector").using(
      "gin",
      table.searchVector,
    ),
  }),
);
```

---

## 4. API 设计

### 4.1 端点

`GET /api/v1/search`

### 4.2 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `q` | string | 是 | — | 搜索关键词，2 ≤ length ≤ 100 |
| `type` | enum | 否 | `problem` | `problem` \| `user` |
| `page` | number | 否 | 1 | 1 ≤ page ≤ 1000 |
| `limit` | number | 否 | 20 | 1 ≤ limit ≤ 50 |
| `include_u` | boolean | 否 | `false` | 仅 admin + type=problem 时生效；为 true 时搜索范围包含 U 型题 |

### 4.3 权限矩阵

| type | 匿名 | 登录用户 | admin |
|------|------|---------|-------|
| `problem` | ✅ 仅 P 型 | ✅ 仅 P 型 | ✅ U+P（可选 `?include_u=true`） |
| `user` | ❌ 401 UNAUTHORIZED | ❌ 403 FORBIDDEN | ✅ |

### 4.4 响应

```json
{
  "data": {
    "query": "动态规划",
    "type": "problem",
    "items": [
      {
        "id": "uuid",
        "type": "P",
        "number": 1042,
        "display_id": "P1042",
        "title": "动态规划入门",
        "difficulty": "medium",
        "rank": 0.060,
        "highlight": "动态规划入门"
      }
    ],
    "total": 23,
    "page": 1,
    "limit": 20,
    "took_ms": 42
  }
}
```

**响应头**：

```
X-Search-Took-Ms: 42
X-Search-Query: <urlencoded query>
```

**字段说明**：

- `highlight`：纯文本，匹配关键词用 `[[HIGHLIGHT]]...[[/HIGHLIGHT]]` 包裹（前端替换为 `<mark>`），避免后端返回 HTML 触发 XSS
- `rank`：ts_rank 相关性分数（0-1），前端可隐藏
- `took_ms`：服务端 SQL 执行耗时（含 rank/highlight 计算）

### 4.5 用户搜索响应字段差异

| 字段 | 非 admin | admin |
|------|----------|-------|
| id | ✅ | ✅ |
| username | ✅ | ✅ |
| email | ❌ | ✅ |
| role | ❌ | ✅ |
| bio | ❌ | ❌（仅本人/管理员通过 `/users/:id/profile` 可见） |

### 4.6 SQL 查询

**题目搜索（公开 + admin 增强）**：

```sql
WITH q AS (
  SELECT websearch_to_tsquery('simple', $1) AS tsq
)
SELECT
  p.id, p.type, p.number, p.title, p.difficulty,
  ts_rank(p.search_vector, q.tsq) AS rank,
  ts_headline('simple', p.title, q.tsq,
    'StartSel=[[HIGHLIGHT]], StopSel=[[/HIGHLIGHT]], MaxWords=20, MinWords=5') AS highlight
FROM problems p, q
WHERE
  (
    p.search_vector @@ q.tsq
    OR p.title ILIKE '%' || $1 || '%'  -- trigram 兜底
  )
  AND (
    $2 = TRUE                          -- admin include_u
    OR p.type = 'P'
  )
ORDER BY rank DESC NULLS LAST, p.number ASC
LIMIT $3 OFFSET $4;
```

**用户搜索（admin only）**：

```sql
WITH q AS (
  SELECT websearch_to_tsquery('simple', $1) AS tsq
)
SELECT
  u.id, u.username, u.email, u.role,
  ts_rank(u.search_vector, q.tsq) AS rank,
  ts_headline('simple', u.username, q.tsq,
    'StartSel=[[HIGHLIGHT]], StopSel=[[/HIGHLIGHT]]') AS highlight
FROM users u, q
WHERE
  (
    u.search_vector @@ q.tsq
    OR u.username ILIKE '%' || $1 || '%'
  )
  AND u.id != '0'  -- 排除 root
ORDER BY rank DESC NULLS LAST, u.username ASC
LIMIT $3 OFFSET $4;
```

**COUNT 查询**：单独跑 `SELECT count(*) FROM ... WHERE ...` 用于分页（可接受 50-100ms 额外开销）。

---

## 5. 限流与安全

### 5.1 限流桶

| 维度 | Redis Key | 默认配置 |
|------|-----------|----------|
| 匿名 IP | `ratelimit:search:ip:<ip>` | 30s/60 次 |
| 登录用户 | `ratelimit:search:user:<user_id>` | 30s/120 次 |
| admin | 不限流 | — |

配置走 **`lib/settings-registry.ts` 注册表**（与现有 `rate_limit_login_*` 一致），共 3 个新条目：

| key | type | default | envFallback | category | 说明 |
|-----|------|---------|-------------|----------|------|
| `rate_limit_search_enabled` | boolean | true | `RATE_LIMIT_SEARCH_ENABLED` | rate_limit | 总开关 |
| `rate_limit_search_window` | integer | 30 | `RATE_LIMIT_SEARCH_WINDOW` | rate_limit | 限流窗口（秒） |
| `rate_limit_search_max_anon` | integer | 60 | `RATE_LIMIT_SEARCH_MAX_ANON` | rate_limit | 匿名 IP 窗口内最大尝试次数 |
| `rate_limit_search_max_authed` | integer | 120 | `RATE_LIMIT_SEARCH_MAX_AUTHED` | rate_limit | 登录用户窗口内最大尝试次数 |

读取通过 `settingInt(key)` / `settingBool(key)`（DB → env fallback → 默认值三级回退），与现有登录限流保持完全一致的运行时配置体验。

**触发限流响应**：

```
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1751606400
Retry-After: 25
```

### 5.2 XSS 防护

- `ts_headline` 输出使用自定义 marker `[[HIGHLIGHT]]...[[/HIGHLIGHT]]`，**不返回 HTML 标签**
- 前端 `SearchResultItem.vue` 负责将 marker 替换为 `<mark>`（受控渲染）

### 5.3 输入校验

| 字段 | 规则 |
|------|------|
| `q` | trim 后 2 ≤ length ≤ 100；UTF-8 |
| `type` | enum: `problem` \| `user` |
| `page` | 整数，1 ≤ page ≤ 1000 |
| `limit` | 整数，1 ≤ limit ≤ 50 |

### 5.4 SQL 注入

- 所有用户输入通过 Drizzle 参数化查询传递（`sql\`...${input}...\`` 中 `${input}` 占位符由驱动转义）
- `q` 字符串通过 `websearch_to_tsquery` 处理，**不直接拼接到 tsquery 字符串**，避免 tsquery 注入
- `ILIKE` 子串也走参数化

---

## 6. 前端设计

### 6.1 新增文件

```
noj-ui/
├── pages/
│   └── search.vue                         # 完整搜索结果页
├── components/
│   ├── feature/
│   │   └── search/
│   │       ├── SearchPalette.vue          # Ctrl+K 命令面板
│   │       └── SearchResultItem.vue       # 单条结果
│   └── layout/
│       └── (NavBar.vue 修改：加搜索按钮)
└── composables/
    └── useSearch.ts                       # 全局搜索状态 + fetch
```

### 6.2 修改文件

- `components/layout/Navbar.vue`：在 UserMenu 前插入 `<button @click="openSearch">`，显示 `<kbd>Ctrl K</kbd>` 提示
- `app.vue` 或 `layouts/default.vue`：挂载 `<SearchPalette />` + 全局 keydown 监听 Ctrl+K / Cmd+K

### 6.3 SearchPalette 行为

| 操作 | 行为 |
|------|------|
| Ctrl+K / Cmd+K（任意页面） | 打开浮层 |
| Esc / 点击遮罩 | 关闭 |
| 输入字符 | debounce 300ms 调用 `useSearch().search(q)` |
| 上下箭头 | 选中项变化（高亮 + 滚动到可见） |
| Enter | 跳转选中项 / 若无选中则跳 `/search?q=xxx&type=all` |
| 清空输入 | 结果列表立即清空 |

浮层内最多展示前 8 条（5 题目 + 3 用户，可在 `useSearch` 中调整），底部固定"按 Enter 查看全部结果 →"。

### 6.4 /search 页面

- 顶部：搜索框（自动聚焦）+ 类型切换 tab（题目/用户/all）
- 中部：结果列表（共用 `SearchResultItem`）
- 底部：分页（`PaginationNav`）+ 耗时显示（`took_ms`）
- URL 同步：`?q=&type=&page=`，刷新可恢复状态

### 6.5 useSearch composable

```typescript
export function useSearch() {
  const state = useState<SearchState>("search:state", () => ({
    open: false,
    query: "",
    type: "all" as "all" | "problem" | "user",
    results: { problems: [], users: [] },
    loading: false,
  }));

  const open = () => { state.value.open = true; };
  const close = () => { state.value.open = false; };

  let debounceTimer: number | null = null;
  const search = (q: string) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (q.trim().length < 2) {
      state.value.results = { problems: [], users: [] };
      state.value.loading = false;
      return;
    }
    state.value.loading = true;
    debounceTimer = setTimeout(async () => {
      try {
        const res = await $fetch("/api/v1/search", {
          params: { q: q.trim(), type: state.value.type, limit: 8 },
        });
        state.value.results = res.data.items;
      } catch (e) {
        // 错误静默处理，浮层内显示 "搜索失败"
        state.value.results = { problems: [], users: [] };
      } finally {
        state.value.loading = false;
      }
    }, 300) as unknown as number;
  };

  return { state: readonly(state), open, close, search };
}
```

---

## 7. 错误处理

| 场景 | HTTP | code | meta |
|------|------|------|------|
| `q` 缺失 | 400 | `VALIDATION_ERROR` | — |
| `q.length < 2` 或 `> 100` | 400 | `VALIDATION_ERROR` | — |
| `type` 非法值 | 400 | `VALIDATION_ERROR` | — |
| `type=user` + 匿名 | 401 | `UNAUTHORIZED` | — |
| `type=user` + 非 admin | 403 | `FORBIDDEN` | — |
| `page` 超界 / 非数字 | 400 | `VALIDATION_ERROR` | — |
| 限流触发 | 429 | `RATE_LIMITED` | retry_after |
| 数据库错误 | 500 | `INTERNAL_ERROR` | request_id |

---

## 8. 测试策略

### 8.1 后端测试（`tests/routes/search.test.ts`）

| 用例 | 期望 |
|------|------|
| 公开搜 "P1001" | 命中题目 1001，rank > 0 |
| 公开搜 "1001" | 命中题目 1001 |
| 公开搜 "动态规划" | 命中 title 含"动态规划"的题目（trigram 兜底） |
| 公开搜 "P" type='U' 的题 | 默认不返回 U 型题 |
| admin 搜 U+P 混合 | 返回 U+P |
| 搜 "Hello"（英文） | tsvector 精确分词命中 |
| q 长度 < 2 | 400 |
| q 长度 > 100 | 400 |
| q 缺失 | 400 |
| type=user 匿名 | 401 |
| type=user 登录非 admin | 403 |
| type=user admin | 返回结果，字段含 email |
| 触发限流（61 次） | 429 |
| 插入新题后能搜到 | 触发器/GENERATED 列生效 |
| 更新题目 title 后能搜到旧 title | 不应命中（tsvector 自动重算） |

### 8.2 前端测试

由于 noj-ui 无单元测试框架，本特性仅在 E2E 测试（`noj-tests/e2e/`）中覆盖：

- `e2e/search.test.ts`：浏览器中打开首页、Ctrl+K 唤起命令面板、输入查询、Enter 跳转
- `e2e/search-admin.test.ts`：admin 登录后搜用户，确认 email 字段可见

### 8.3 性能验证

- 在测试库注入 10 万题 + 1 万用户种子数据
- `EXPLAIN ANALYZE` 验证 GIN 索引被使用
- 端到端调用搜索 API，断言 `took_ms < 500`

---

## 9. 迁移与回滚

### 9.1 部署顺序

1. 应用启动时 `migrate.ts` 自动执行 `0017_search_indexes.sql`
2. 启动失败 → 应用拒绝启动（迁移失败为致命错误）
3. 启动成功 → tsvector 自动重算所有现有数据（ALTER TABLE 时 PG 自动填充 GENERATED 列）

### 9.2 回滚 SQL（手动）

```sql
DROP INDEX IF EXISTS idx_users_username_trgm;
DROP INDEX IF EXISTS idx_users_search_vector;
DROP INDEX IF EXISTS idx_problems_title_trgm;
DROP INDEX IF EXISTS idx_problems_search_vector;
ALTER TABLE users DROP COLUMN IF EXISTS search_vector;
ALTER TABLE problems DROP COLUMN IF EXISTS search_vector;
-- 不卸载 pg_trgm 扩展（可能将来其它特性复用）
```

回滚后 API 端点不存在（routes/search.ts 不会被部署），无残留代码依赖。

---

## 10. 工作量估算

| 模块 | 文件 | 行数（含测试） |
|------|------|----------------|
| 后端 - 路由 | `routes/search.ts` | ~80 |
| 后端 - 服务 | `services/search.ts` | ~250 |
| 后端 - 限流扩展 | `lib/settings-registry.ts` 注册 4 个新条目 | ~50 |
| 后端 - 测试 | `tests/routes/search.test.ts` + `tests/services/search.test.ts` | ~350 |
| 前端 - composable | `composables/useSearch.ts` | ~80 |
| 前端 - 命令面板 | `components/feature/search/SearchPalette.vue` | ~200 |
| 前端 - 结果项 | `components/feature/search/SearchResultItem.vue` | ~80 |
| 前端 - 结果页 | `pages/search.vue` | ~180 |
| 前端 - Navbar 改造 | `components/layout/Navbar.vue` 增量 | ~20 |
| 前端 - E2E | `noj-tests/e2e/search.test.ts` | ~100 |
| 数据库 - 迁移 | `drizzle/0017_search_indexes.sql` | ~30 |
| 文档 | 本设计文档 + OpenSpec 规范 | ~150 |
| **总计** | | **~1550 行** |

预估工期：**2-3 天**（含评审 + 测试 + E2E 验证）。

---

## 11. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| pg_trgm 在中文环境召回率仍不足 | 中 | 中 | 加 GIN trigram 索引 + `ILIKE` 兜底；后续可观察用户反馈决定是否引入 zhparser |
| 10 万题时索引体积过大（>500MB） | 低 | 中 | 当前估算 ~220MB；监控到位即可 |
| GENERATED 列在某些 PG 版本不可用 | 低 | 高 | 文档要求 PG 12+，项目已用 PG 16 |
| 限流误伤真实用户 | 中 | 低 | 默认 60 次/30s 较宽松；用户可调高配置 |
| 触发 XSS（ts_headline 输出） | 低 | 高 | 用 `[[HIGHLIGHT]]` marker 而非 `<b>` |
| 搜索结果暴露未公开 U 型题 | 中 | 中 | SQL 层默认加 `type='P'` 过滤 |

---

## 12. 后续可扩展（不在本次范围内）

- 题目 description 加入搜索（修改 GENERATED 表达式）
- 搜索历史记录（用户维度）
- 搜索建议 / autocomplete（独立 word bank 表）
- 高级搜索语法（`tag:difficulty=easy author:alice`）
- 跨字段相关性微调（基于点击反馈的 learning to rank）

---

## 附录 A：相关 issue 与规范

- 父 issue：https://github.com/Neuro-OJ/neuro-oj/issues/100
- 现有私信用户搜索：`noj-core/src/routes/users.ts` `/search`
- 现有题目 keyword 搜索：`noj-core/src/services/problems.ts` `listProblems` 内 `ILIKE`
- 限流基础设施：`noj-core/src/lib/rateLimitEnv.ts`
- 速率限制规范：openspec/specs/admin-authorization（issue #73）

## 附录 B：参考文献

- [PostgreSQL Full Text Search](https://www.postgresql.org/docs/current/textsearch.html)
- [pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html)
- [Drizzle ORM Generated Columns](https://orm.drizzle.team/docs/generated-columns)
- [Hono Rate Limiting Patterns](https://hono.dev/)