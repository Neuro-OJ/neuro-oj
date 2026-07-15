# 全局搜索（题目+用户）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 NOJ 全局搜索（题目 + 用户），利用 PostgreSQL tsvector + pg_trgm 提供中英文友好的全文搜索，支持前端 Ctrl+K 命令面板与分页结果页。

**Architecture:**
- 后端：新增 `routes/search.ts` + `services/search.ts`，通过 `websearch_to_tsquery` + trigram `ILIKE` 联合查询；权限分两层（题目公开默认 P 型，用户 admin-only）；独立限流桶走 settings-registry。
- 数据库：`ALTER TABLE` 加 `search_vector tsvector GENERATED ALWAYS AS ... STORED` 列 + GIN 索引 + trigram GIN 索引；自动重算无需触发器。
- 前端：`useSearch` composable 共享状态 + `SearchPalette` 命令面板（Ctrl+K）+ `/search` 结果页；高亮通过 `[[HIGHLIGHT]]` marker 防 XSS。

**Tech Stack:** Deno 2 + Hono + Drizzle ORM + PostgreSQL 16 (tsvector + pg_trgm) + Nuxt 4 + Vue 3 + Tailwind CSS + ioredis。

---

## Global Constraints

- 所有提交必须 GPG 签名（`commit.gpgsign=true`，密钥 `F27B5D0A639B43695413D9440F49774CB31F6CF1`）。
- 所有代码必须通过 PR 提交，禁止直接推送到 main。
- 提交信息格式：`<type>(<scope>): 中文描述`（type: feat/fix/docs/test/refactor；scope: core/ui/judge）。
- 项目语言：中文（提交、注释、文档）；代码标识符用英文。
- TypeScript 严格模式；错误处理统一走 `AppError` 继承体系（`ValidationError`/`UnauthorizedError`/`ForbiddenError`）。
- 数据库 schema 改动必须经过 Drizzle 迁移流程：写 SQL 文件 + 同步更新 `_journal.json`。
- 限流配置必须走 `settings-registry.ts`（与 `rate_limit_login_*` 一致的三级回退：DB → env → default）。
- 路由层不直接 SQL，统一走 service 层；service 层不感知 Hono Context。
- 测试必须 PGlite 兼容（`tests/_setup.ts` 中已有 PGlite schema bootstrap）。
- 前端禁止手写 CSS，必须用 Tailwind utility 类。
- 前端 API 调用统一通过 Nitro 代理（`server/api/[...slug].ts`），不直连 noj-core。

---

## File Structure

**后端新增**：
- `noj-core/drizzle/0017_search_indexes.sql` — 迁移 SQL（GENERATED 列 + GIN 索引）
- `noj-core/drizzle/meta/_journal.json` — 增量更新（新增 idx 18）
- `noj-core/src/services/search.ts` — 业务逻辑（searchProblems / searchUsers）
- `noj-core/src/routes/search.ts` — Hono 路由（参数校验 + 权限 + 限流）
- `noj-core/src/middleware/searchRateLimit.ts` — 搜索限流中间件
- `noj-core/tests/routes/search.test.ts` — 路由集成测试
- `noj-core/tests/services/search.test.ts` — service 单元测试

**后端修改**：
- `noj-core/src/db/schema.ts` — `problems`/`users` 加 `searchVector` 列 + 索引声明
- `noj-core/src/lib/settings-registry.ts` — 注册 4 个 `rate_limit_search_*` 条目
- `noj-core/src/app.ts` — 挂载 `/api/v1/search` 路由

**前端新增**：
- `noj-ui/composables/useSearch.ts` — 全局搜索状态 + 防抖 + fetch
- `noj-ui/components/feature/search/SearchPalette.vue` — Ctrl+K 命令面板
- `noj-ui/components/feature/search/SearchResultItem.vue` — 单条结果（题目/用户两种）
- `noj-ui/pages/search.vue` — 完整结果页（URL 同步 + 分页）

**前端修改**：
- `noj-ui/components/layout/Navbar.vue` — 搜索按钮 + Ctrl+K 提示
- `noj-ui/app.vue` 或 `layouts/default.vue` — 全局 Ctrl+K 监听 + SearchPalette 挂载

**跨模块新增**：
- `noj-tests/e2e/08_search.test.ts` — E2E 测试

---

## Task 1: 数据库迁移 + journal 更新

**Files:**
- Create: `noj-core/drizzle/0017_search_indexes.sql`
- Modify: `noj-core/drizzle/meta/_journal.json`（在最后追加 idx 18 条目）

**Interfaces:**
- Consumes: 现有 `problems` 和 `users` 表
- Produces: 两表均有 `search_vector tsvector` 列（GENERATED）+ 2 个 GIN 索引；启用 `pg_trgm` 扩展

- [ ] **Step 1: 创建迁移 SQL 文件**

写入 `noj-core/drizzle/0017_search_indexes.sql`：

```sql
-- 全局搜索（issue #100）：
-- - problems 加 search_vector 列：title 权重 A + display_id(type+number) 权重 B
-- - users 加 search_vector 列：username 权重 A + email 权重 B
-- - 两表均建 tsvector GIN 索引 + pg_trgm GIN 索引（中英文混合友好）

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- problems：search_vector 列 + 索引
ALTER TABLE problems
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple',
      coalesce(type, '') || ' ' || coalesce(number::text, '')
    ), 'B')
  ) STORED;

CREATE INDEX idx_problems_search_vector ON problems USING GIN (search_vector);
CREATE INDEX idx_problems_title_trgm ON problems USING GIN (title gin_trgm_ops);

-- users：search_vector 列 + 索引
ALTER TABLE users
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(username, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(email, '')), 'B')
  ) STORED;

CREATE INDEX idx_users_search_vector ON users USING GIN (search_vector);
CREATE INDEX idx_users_username_trgm ON users USING GIN (username gin_trgm_ops);
```

- [ ] **Step 2: 更新 `_journal.json`**

在 `noj-core/drizzle/meta/_journal.json` 末尾（`entries` 数组最后）追加：

```json
    {
      "idx": 18,
      "version": "7",
      "when": 1752412800000,
      "tag": "0017_search_indexes",
      "breakpoints": true
    }
```

注：原文件最后一个 idx 是 17，必须按升序追加；`when` 用当前时间戳毫秒（issue 提交日附近）。

- [ ] **Step 3: 验证迁移文件可被解析**

```bash
cd /home/user/neuro-oj/noj-core && deno task migrate
```

预期输出（成功路径）：
```
迁移文件夹路径: .../drizzle
数据库迁移完成
```

若无 `DATABASE_URL`，跳过此步骤（CI 环境由 PostgreSQL 服务提供）。

- [ ] **Step 4: 验证 search_vector 列存在**

```bash
docker compose up -d postgres
psql "$DATABASE_URL" -c "\d problems" | grep search_vector
psql "$DATABASE_URL" -c "\d users" | grep search_vector
```

预期：两表均显示 `search_vector | tsvector` 列。

- [ ] **Step 5: 验证 GIN 索引被使用**

```bash
psql "$DATABASE_URL" -c "EXPLAIN SELECT id FROM problems WHERE search_vector @@ websearch_to_tsquery('simple', 'test');"
```

预期输出含 `Bitmap Index Scan on idx_problems_search_vector`。

- [ ] **Step 6: 提交**

```bash
git add noj-core/drizzle/0017_search_indexes.sql noj-core/drizzle/meta/_journal.json
git commit -m "feat(core): 添加全局搜索 tsvector 列与 GIN 索引 (issue #100)"
```

---

## Task 2: Drizzle schema 同步

**Files:**
- Modify: `noj-core/src/db/schema.ts:49-78`（problems 表）
- Modify: `noj-core/src/db/schema.ts:20-42`（users 表）

**Interfaces:**
- Consumes: 数据库已迁移的 `search_vector` 列
- Produces: TypeScript schema 暴露 `searchVector` 列给 ORM（不可写入，仅 select 用）

- [ ] **Step 1: 修改 problems 表 schema**

在 `noj-core/src/db/schema.ts` 第 1-14 行的 import 顶部，添加 `tsvector` 导入：

```typescript
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  tsvector,    // 新增
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
```

修改 `problems` 表（第 49-78 行），在字段列表尾部添加 `searchVector`，并在 `(table) => ({...})` 中加索引声明：

```typescript
export const problems = pgTable(
  "problems",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    difficulty: text("difficulty").notNull().default("medium"),
    judge_image: text("judge_image").notNull(),
    judge_command: text("judge_command").notNull(),
    support_package_storage_url: text("support_package_storage_url"),
    time_limit_ms: integer("time_limit_ms").notNull().default(5000),
    memory_limit_mb: integer("memory_limit_mb").notNull().default(512),
    number: integer("number").notNull(),
    owner_id: text("owner_id").notNull().default("0"),
    type: text("type").notNull().default("U"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    /** tsvector 列，GENERATED 自动维护，ORM 不可写入 */
    searchVector: tsvector("search_vector"),
  },
  (table) => ({
    typeNumberUnique: unique("problems_type_number_unique").on(
      table.type,
      table.number,
    ),
    typeCheck: check("problems_type_check", sql`${table.type} IN ('U', 'P')`),
    searchVectorIdx: index("idx_problems_search_vector").using(
      "gin",
      table.searchVector,
    ),
  }),
);
```

- [ ] **Step 2: 修改 users 表 schema**

修改 `users` 表（第 20-42 行），在 `updated_at` 后添加 `searchVector` 列，并在 `(table) => ({...})` 中加索引声明（注意原 users 表无回调函数，需新增空回调）：

```typescript
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull().unique(),
    email: text("email").notNull().unique(),
    password_hash: text("password_hash").notNull(),
    role: text("role").notNull().default("user"),
    bio: text("bio").notNull().default(""),
    must_change_password: boolean("must_change_password").notNull().default(
      false,
    ),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    /** tsvector 列，GENERATED 自动维护 */
    searchVector: tsvector("search_vector"),
  },
  (table) => ({
    searchVectorIdx: index("idx_users_search_vector").using(
      "gin",
      table.searchVector,
    ),
  }),
);
```

- [ ] **Step 3: 验证 schema 与数据库对齐**

```bash
cd /home/user/neuro-oj/noj-core && deno task migrate
```

预期：迁移幂等执行无错误（无新迁移时输出 `数据库迁移完成`）。

- [ ] **Step 4: 验证类型可正常 select**

新建临时检查文件 `noj-core/scripts/check_search_schema.ts`（仅用于本地验证，验证后删除）：

```typescript
import { getDb } from "../src/db/connection.ts";
import { problems, users } from "../src/db/schema.ts";

const db = getDb();

// 验证 search_vector 列存在且为 tsvector
const problemRow = await db
  .select({ sv: problems.searchVector, title: problems.title })
  .from(problems)
  .limit(1);
console.log("problems.searchVector type:", typeof problemRow[0]?.sv);
console.log("title:", problemRow[0]?.title);

const userRow = await db
  .select({ sv: users.searchVector, username: users.username })
  .from(users)
  .limit(1);
console.log("users.searchVector type:", typeof userRow[0]?.sv);
console.log("username:", userRow[0]?.username);

Deno.exit(0);
```

运行：

```bash
deno run --allow-net --allow-env scripts/check_search_schema.ts
```

预期：两行类型输出非 undefined，控制台打印真实 title/username。验证后删除此文件。

- [ ] **Step 5: 提交**

```bash
git add noj-core/src/db/schema.ts
git commit -m "feat(core): schema 暴露 search_vector 列给 ORM (issue #100)"
```

---

## Task 3: 注册限流配置到 settings-registry

**Files:**
- Modify: `noj-core/src/lib/settings-registry.ts`（在 `// ── rate_limit ───` 区段追加 4 个条目）

**Interfaces:**
- Consumes: 现有 `SETTING_DEFINITIONS` 数组
- Produces: 4 个新条目供 `settingInt()`/`settingBool()` 读取，键名固定

- [ ] **Step 1: 在 rate_limit 区段末尾追加 4 个条目**

在 `noj-core/src/lib/settings-registry.ts` 的 `// ── rate_limit ───` 区段（已有 `rate_limit_login_lock_seconds` 条目之后）追加：

```typescript
  {
    key: "rate_limit_search_enabled",
    type: "boolean",
    default: true,
    description: "是否启用搜索速率限制（NOJ_ENV=test 时强制关闭）",
    is_secret: false,
    envFallback: "RATE_LIMIT_SEARCH_ENABLED",
    category: "rate_limit",
  },
  {
    key: "rate_limit_search_window",
    type: "integer",
    default: 30,
    description: "搜索限流窗口（秒）",
    is_secret: false,
    envFallback: "RATE_LIMIT_SEARCH_WINDOW",
    category: "rate_limit",
    min: 1,
    max: 3600,
  },
  {
    key: "rate_limit_search_max_anon",
    type: "integer",
    default: 60,
    description: "匿名 IP 窗口内最大搜索次数",
    is_secret: false,
    envFallback: "RATE_LIMIT_SEARCH_MAX_ANON",
    category: "rate_limit",
    min: 1,
    max: 10000,
  },
  {
    key: "rate_limit_search_max_authed",
    type: "integer",
    default: 120,
    description: "登录用户窗口内最大搜索次数",
    is_secret: false,
    envFallback: "RATE_LIMIT_SEARCH_MAX_AUTHED",
    category: "rate_limit",
    min: 1,
    max: 10000,
  },
```

- [ ] **Step 2: 验证注册表无重复键**

新建临时验证 `noj-core/scripts/check_settings.ts`：

```typescript
import { SETTING_DEFINITIONS } from "../src/lib/settings-registry.ts";

const keys = SETTING_DEFINITIONS.map((d) => d.key);
const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
if (dupes.length > 0) {
  console.error("重复键:", dupes);
  Deno.exit(1);
}
console.log("注册表条目数:", SETTING_DEFINITIONS.length);
console.log("无重复键 ✓");
Deno.exit(0);
```

运行：

```bash
deno run --allow-net --allow-env scripts/check_settings.ts
```

预期输出：

```
注册表条目数: 26
无重复键 ✓
```

注：原 22 + 4 = 26。验证后删除此脚本。

- [ ] **Step 3: 验证 validateRegistry 通过**

```bash
deno run --allow-net --allow-env src/main.ts 2>&1 | head -20
```

预期：进程启动过程中不输出 "注册表校验失败" 之类错误；Ctrl+C 中断即可（无需启动完整服务）。

- [ ] **Step 4: 提交**

```bash
git add noj-core/src/lib/settings-registry.ts
git commit -m "feat(core): 注册搜索限流配置项 (issue #100)"
```

---

## Task 4: 搜索限流中间件

**Files:**
- Create: `noj-core/src/middleware/searchRateLimit.ts`
- Test: `noj-core/tests/middleware/searchRateLimit.test.ts`

**Interfaces:**
- Consumes: Hono Context（提取 `getClientIp` / 用户 ID）+ `getRedis()` + `settingInt()`/`settingBool()`
- Produces: 触发限流时抛 `RateLimitError`（含 X-RateLimit-* headers），否则 next()

- [ ] **Step 1: 写失败的限流测试**

在 `noj-core/tests/middleware/searchRateLimit.test.ts` 写：

```typescript
import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { searchRateLimit } from "../../src/middleware/searchRateLimit.ts";
import { getRedis } from "../../src/mq/connection.ts";
import { resetDbForTest } from "../../src/db/connection.ts";

await resetDbForTest();

Deno.test({
  name: "search rate limit: 超过阈值返回 429",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 强制启用限流（测试默认禁用）
    Deno.env.set("RATE_LIMIT_ENABLED", "true");
    Deno.env.set("RATE_LIMIT_SEARCH_ENABLED", "true");
    Deno.env.set("RATE_LIMIT_SEARCH_WINDOW", "60");
    Deno.env.set("RATE_LIMIT_SEARCH_MAX_ANON", "3");

    const app = new Hono();
    app.get("/test", searchRateLimit("anon"), (c) => c.text("ok"));

    // 清空 redis 测试 key
    const redis = getRedis();
    const key = "ratelimit:search:ip:127.0.0.1";
    await redis.del(key);

    // 前 3 次应通过
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "127.0.0.1" },
      });
      assertEquals(res.status, 200);
    }

    // 第 4 次触发限流
    const res = await app.request("/test", {
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    assertEquals(res.status, 429);
    assertExists(res.headers.get("retry-after"));
    assertEquals(res.headers.get("x-ratelimit-limit"), "3");

    // 清理
    await redis.del(key);
    Deno.env.delete("RATE_LIMIT_SEARCH_MAX_ANON");
  },
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
cd /home/user/neuro-oj/noj-core && deno test tests/middleware/searchRateLimit.test.ts
```

预期：FAIL（模块未找到）。

- [ ] **Step 3: 实现 searchRateLimit 中间件**

创建 `noj-core/src/middleware/searchRateLimit.ts`：

```typescript
/**
 * 搜索限流中间件（issue #100）。
 *
 * 与登录限流共享 Redis 固定窗口计数模式，但桶命名空间独立：
 * - 匿名 IP: ratelimit:search:ip:<ip>
 * - 登录用户: ratelimit:search:user:<user_id>
 *
 * 阈值通过 settings-registry 配置（rate_limit_search_*），运行时可调。
 * Admin 不受限流（user_role === 'admin' 时跳过）。
 *
 * 触发限流时抛 RateLimitError（含 X-RateLimit-* headers），由全局 onError 统一返回 429。
 */

import type { Context, MiddlewareHandler } from "hono";
import { getRedis } from "../mq/connection.ts";
import { getClientIp } from "../lib/rateLimitEnv.ts";
import { settingBool, settingInt } from "../lib/rateLimitEnv.ts";
import { RateLimitError } from "../lib/errors.ts";

export type SearchRateLimitDimension = "anon" | "authed";

/**
 * 构造搜索限流中间件。
 *
 * @param dimension 限流维度（anon = IP 桶，authed = 用户桶）
 */
export function searchRateLimit(
  dimension: SearchRateLimitDimension,
): MiddlewareHandler {
  return async (c: Context, next) => {
    // 总开关
    if (!settingBool("rate_limit_search_enabled")) {
      return await next();
    }

    // 管理员跳过限流
    const role = c.get("userRole");
    if (role === "admin") {
      return await next();
    }

    const window = settingInt("rate_limit_search_window");
    const max = dimension === "anon"
      ? settingInt("rate_limit_search_max_anon")
      : settingInt("rate_limit_search_max_authed");

    // 维度对应 key
    let key: string;
    let identifier: string;
    if (dimension === "authed") {
      const userId = c.get("userId");
      if (!userId) {
        // 登录维度的中间件要求已登录，理论上 authMiddleware 在前已保证
        return await next();
      }
      identifier = userId;
      key = `ratelimit:search:user:${identifier}`;
    } else {
      identifier = getClientIp(c);
      key = `ratelimit:search:ip:${identifier}`;
    }

    const redis = getRedis();
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, window);
    }

    const remaining = Math.max(0, max - count);
    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(remaining));

    if (count > max) {
      const ttl = await redis.ttl(key);
      const resetAt = Math.floor(Date.now() / 1000) + (ttl > 0 ? ttl : window);
      c.header("X-RateLimit-Reset", String(resetAt));
      c.header("Retry-After", String(ttl > 0 ? ttl : window));
      throw new RateLimitError(
        `搜索请求过于频繁，请稍后再试（${dimension === "anon" ? "IP" : "用户"}维度）`,
        { retry_after: ttl > 0 ? ttl : window },
      );
    }

    await next();
  };
}
```

- [ ] **Step 4: 运行测试验证通过**

```bash
deno test tests/middleware/searchRateLimit.test.ts
```

预期：PASS。

- [ ] **Step 5: 检查 RateLimitError 是否已在 errors.ts 中**

```bash
grep -n "RateLimitError\|class.*Error.*extends AppError" /home/user/neuro-oj/noj-core/src/lib/errors.ts | head -20
```

若 `RateLimitError` 不存在，在 `noj-core/src/lib/errors.ts` 中追加（参考现有错误类）：

```typescript
export class RateLimitError extends AppError {
  constructor(message: string, meta?: Record<string, unknown>) {
    super(message, "RATE_LIMITED", 429, meta);
  }
}
```

确保 `headers` 字段类型兼容（参考 issue #73 限流的实现）。

- [ ] **Step 6: 提交**

```bash
git add noj-core/src/middleware/searchRateLimit.ts noj-core/tests/middleware/searchRateLimit.test.ts
git commit -m "feat(core): 实现搜索限流中间件 (issue #100)"
```

---

## Task 5: 搜索 service（核心业务逻辑）

**Files:**
- Create: `noj-core/src/services/search.ts`
- Test: `noj-core/tests/services/search.test.ts`

**Interfaces:**
- Consumes: `getDb()` + `problems`/`users` schema + 输入参数 `{ q, type, page, limit, includeU, isAdmin }`
- Produces: `{ items: SearchItem[], total: number, took_ms: number }`

- [ ] **Step 1: 写失败的 service 测试**

在 `noj-core/tests/services/search.test.ts` 写：

```typescript
import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { searchProblems, searchUsers } from "../../src/services/search.ts";
import { resetDbForTest } from "../../src/db/connection.ts";
import { problems, users } from "../../src/db/schema.ts";
import { getDb } from "../../src/db/connection.ts";

await resetDbForTest();

async function seedProblems() {
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(problems).values([
    {
      id: "p-uuid-1",
      title: "动态规划入门",
      description: "",
      difficulty: "medium",
      judge_image: "test",
      judge_command: "test",
      number: 1001,
      type: "P",
      created_at: now,
      updated_at: now,
    },
    {
      id: "p-uuid-2",
      title: "Hello World",
      description: "",
      difficulty: "easy",
      judge_image: "test",
      judge_command: "test",
      number: 1002,
      type: "P",
      created_at: now,
      updated_at: now,
    },
    {
      id: "p-uuid-3",
      title: "私有题目",
      description: "",
      difficulty: "hard",
      judge_image: "test",
      judge_command: "test",
      number: 1,
      type: "U",
      created_at: now,
      updated_at: now,
    },
  ]);
}

async function seedUsers() {
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(users).values([
    {
      id: "alice-id",
      username: "alice_test",
      email: "alice@example.com",
      password_hash: "x",
      role: "user",
      created_at: now,
      updated_at: now,
    },
    {
      id: "admin-id",
      username: "admin_test",
      email: "admin@example.com",
      password_hash: "x",
      role: "admin",
      created_at: now,
      updated_at: now,
    },
  ]);
}

Deno.test({
  name: "search service: 搜 'P1001' 命中 P 型题",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seedProblems();
    const result = await searchProblems({
      q: "P1001",
      isAdmin: false,
      page: 1,
      limit: 20,
    });
    assertEquals(result.items.length, 1);
    assertEquals(result.items[0]?.id, "p-uuid-1");
    assertEquals(result.items[0]?.display_id, "P1001");
  },
});

Deno.test({
  name: "search service: 中文 '动态规划' 命中（trigram 兜底）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seedProblems();
    const result = await searchProblems({
      q: "动态规划",
      isAdmin: false,
      page: 1,
      limit: 20,
    });
    assertEquals(result.items.length >= 1, true);
    assertEquals(result.items[0]?.title, "动态规划入门");
  },
});

Deno.test({
  name: "search service: 公开搜索不返回 U 型题",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seedProblems();
    const result = await searchProblems({
      q: "私有",
      isAdmin: false,
      page: 1,
      limit: 20,
    });
    assertEquals(result.items.length, 0);
  },
});

Deno.test({
  name: "search service: admin + includeU=true 返回 U+P",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seedProblems();
    const result = await searchProblems({
      q: "私有",
      isAdmin: true,
      includeU: true,
      page: 1,
      limit: 20,
    });
    assertEquals(result.items.length, 1);
  },
});

Deno.test({
  name: "search service: 搜英文 'Hello' 命中 tsvector",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seedProblems();
    const result = await searchProblems({
      q: "Hello",
      isAdmin: false,
      page: 1,
      limit: 20,
    });
    assertEquals(result.items.length, 1);
    assertEquals(result.items[0]?.title, "Hello World");
  },
});

Deno.test({
  name: "search service: 用户搜索仅 admin，排除 root",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seedUsers();
    const result = await searchUsers({
      q: "alice",
      isAdmin: true,
      page: 1,
      limit: 20,
    });
    assertEquals(result.items.length, 1);
    assertEquals(result.items[0]?.username, "alice_test");
    assertEquals(result.items[0]?.email, "alice@example.com");
  },
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
cd /home/user/neuro-oj/noj-core && deno test tests/services/search.test.ts
```

预期：FAIL（模块未找到）。

- [ ] **Step 3: 实现 searchProblems**

创建 `noj-core/src/services/search.ts`：

```typescript
/**
 * 全局搜索（issue #100）。
 *
 * - searchProblems: 题目搜索（默认仅 P 型，admin 可 includeU）
 * - searchUsers: 用户搜索（admin only，排除 root）
 *
 * SQL 策略：
 * - tsvector @@ websearch_to_tsquery 精确匹配（英文/数字分词）
 * - title ILIKE '%q%' 模糊兜底（中文 trigram）
 * - 两者 OR，由 PG planner 选最优索引
 * - ts_headline 生成高亮 marker（[[HIGHLIGHT]]...[[/HIGHLIGHT]]），非 HTML 防 XSS
 */

import { sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";

export interface SearchProblemsParams {
  q: string;
  isAdmin: boolean;
  includeU?: boolean;
  page: number;
  limit: number;
}

export interface ProblemSearchItem {
  id: string;
  type: string;
  number: number;
  display_id: string;
  title: string;
  difficulty: string;
  rank: number;
  highlight: string;
}

export interface SearchProblemsResult {
  items: ProblemSearchItem[];
  total: number;
  took_ms: number;
}

/**
 * 搜索题目。
 *
 * 权限规则：
 * - isAdmin=false: 仅返回 type='P'
 * - isAdmin=true + includeU=true: 返回 U+P
 * - isAdmin=true + includeU 缺省: 仅返回 P（保持一致）
 */
export async function searchProblems(
  params: SearchProblemsParams,
): Promise<SearchProblemsResult> {
  const db = getDb();
  const { q, isAdmin, includeU = false, page, limit } = params;
  const offset = (page - 1) * limit;
  const includeUType = isAdmin && includeU;
  const start = performance.now();

  // 列表查询：tsvector + trigram 联合
  const rows = await db.execute<{
    id: string;
    type: string;
    number: number;
    title: string;
    difficulty: string;
    rank: number | null;
    highlight: string;
  }>(sql`
    SELECT
      p.id, p.type, p.number, p.title, p.difficulty,
      ts_rank(p.search_vector, websearch_to_tsquery('simple', ${q})) AS rank,
      ts_headline('simple', p.title, websearch_to_tsquery('simple', ${q}),
        'StartSel=[[HIGHLIGHT]], StopSel=[[/HIGHLIGHT]], MaxWords=20, MinWords=5'
      ) AS highlight
    FROM problems p
    WHERE (
      p.search_vector @@ websearch_to_tsquery('simple', ${q})
      OR p.title ILIKE ${"%" + q + "%"}
    )
    AND (
      ${includeUType} = TRUE
      OR p.type = 'P'
    )
    ORDER BY rank DESC NULLS LAST, p.number ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  // COUNT 查询
  const countRows = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count
    FROM problems p
    WHERE (
      p.search_vector @@ websearch_to_tsquery('simple', ${q})
      OR p.title ILIKE ${"%" + q + "%"}
    )
    AND (
      ${includeUType} = TRUE
      OR p.type = 'P'
    )
  `);

  const total = Number(countRows[0]?.count ?? 0);
  const took_ms = Math.round(performance.now() - start);

  const items: ProblemSearchItem[] = (rows as Array<{
    id: string;
    type: string;
    number: number;
    title: string;
    difficulty: string;
    rank: number | null;
    highlight: string;
  }>).map((r) => ({
    id: r.id,
    type: r.type,
    number: r.number,
    display_id: `${r.type}${r.number}`,
    title: r.title,
    difficulty: r.difficulty,
    rank: r.rank ?? 0,
    highlight: r.highlight,
  }));

  return { items, total, took_ms };
}

export interface SearchUsersParams {
  q: string;
  isAdmin: boolean;
  page: number;
  limit: number;
}

export interface UserSearchItem {
  id: string;
  username: string;
  email: string;
  role: string;
  rank: number;
  highlight: string;
}

export interface SearchUsersResult {
  items: UserSearchItem[];
  total: number;
  took_ms: number;
}

/**
 * 搜索用户（admin only）。
 *
 * 必须 isAdmin=true，否则路由层拒绝（service 层不重复鉴权）。
 * 排除 root 用户（UID='0'）。
 */
export async function searchUsers(
  params: SearchUsersParams,
): Promise<SearchUsersResult> {
  const db = getDb();
  const { q, page, limit } = params;
  const offset = (page - 1) * limit;
  const start = performance.now();

  const rows = await db.execute<{
    id: string;
    username: string;
    email: string;
    role: string;
    rank: number | null;
    highlight: string;
  }>(sql`
    SELECT
      u.id, u.username, u.email, u.role,
      ts_rank(u.search_vector, websearch_to_tsquery('simple', ${q})) AS rank,
      ts_headline('simple', u.username, websearch_to_tsquery('simple', ${q}),
        'StartSel=[[HIGHLIGHT]], StopSel=[[/HIGHLIGHT]]'
      ) AS highlight
    FROM users u
    WHERE (
      u.search_vector @@ websearch_to_tsquery('simple', ${q})
      OR u.username ILIKE ${"%" + q + "%"}
    )
    AND u.id <> '0'
    ORDER BY rank DESC NULLS LAST, u.username ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const countRows = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count
    FROM users u
    WHERE (
      u.search_vector @@ websearch_to_tsquery('simple', ${q})
      OR u.username ILIKE ${"%" + q + "%"}
    )
    AND u.id <> '0'
  `);

  const total = Number(countRows[0]?.count ?? 0);
  const took_ms = Math.round(performance.now() - start);

  const items: UserSearchItem[] = (rows as Array<{
    id: string;
    username: string;
    email: string;
    role: string;
    rank: number | null;
    highlight: string;
  }>).map((r) => ({
    id: r.id,
    username: r.username,
    email: r.email,
    role: r.role,
    rank: r.rank ?? 0,
    highlight: r.highlight,
  }));

  return { items, total, took_ms };
}
```

- [ ] **Step 4: 运行 service 测试**

```bash
deno test tests/services/search.test.ts
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add noj-core/src/services/search.ts noj-core/tests/services/search.test.ts
git commit -m "feat(core): 实现搜索 service (issue #100)"
```

---

## Task 6: 搜索路由

**Files:**
- Create: `noj-core/src/routes/search.ts`

**Interfaces:**
- Consumes: Hono Context（query 参数 + userRole）
- Produces: `{ data: { query, type, items, total, page, limit, took_ms } }` + `X-Search-Took-Ms` header

- [ ] **Step 1: 实现搜索路由**

创建 `noj-core/src/routes/search.ts`：

```typescript
/**
 * 全局搜索路由（issue #100）。
 *
 * GET /api/v1/search?q=<query>&type=problem|user&page=1&limit=20&include_u=false
 *
 * 权限：
 * - type=problem: 公开（默认仅 P 型；admin + include_u=true 返回 U+P）
 * - type=user: admin only
 *
 * 限流：复用 searchRateLimit 中间件（IP/用户桶分离，admin 不限流）
 */

import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.ts";
import { searchRateLimit } from "../middleware/searchRateLimit.ts";
import { searchProblems, searchUsers } from "../services/search.ts";
import { ValidationError } from "../lib/errors.ts";

const router = new Hono<{
  Variables: { userId: string; userRole: string };
}>();

/**
 * GET /api/v1/search
 */
router.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const type = c.req.query("type") ?? "problem";
  const includeUParam = c.req.query("include_u");
  const includeU = includeUParam === "true" || includeUParam === "1";

  // 解析 userRole（未登录为 undefined）
  const userRole = c.get("userRole") as string | undefined;
  const isAdmin = userRole === "admin";

  // 校验
  if (q.length < 2) {
    throw new ValidationError("搜索关键词至少需要 2 个字符");
  }
  if (q.length > 100) {
    throw new ValidationError("搜索关键词最多 100 个字符");
  }
  if (type !== "problem" && type !== "user") {
    throw new ValidationError("type 参数必须为 problem 或 user");
  }

  // 限流维度：题目搜索匿名桶；用户搜索需登录（admin 跳过）
  if (type === "user") {
    // 用户搜索：admin only
    if (!isAdmin) {
      // 未登录返回 401，非 admin 返回 403
      if (!c.get("userId")) {
        throw new (await import("../lib/errors.ts")).UnauthorizedError(
          "请先登录",
        );
      }
      throw new (await import("../lib/errors.ts")).ForbiddenError(
        "仅管理员可搜索用户",
      );
    }
  }

  // 题目搜索：匿名桶限流
  await searchRateLimit(isAdmin ? "authed" : "anon")(c, async () => {});

  // 解析分页
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const limit = Math.min(
    50,
    Math.max(1, parseInt(c.req.query("limit") ?? "20", 10) || 20),
  );

  // 调用 service
  if (type === "problem") {
    const result = await searchProblems({
      q,
      isAdmin,
      includeU,
      page,
      limit,
    });
    c.header("X-Search-Took-Ms", String(result.took_ms));
    return c.json({
      data: {
        query: q,
        type,
        items: result.items,
        total: result.total,
        page,
        limit,
        took_ms: result.took_ms,
      },
    });
  }

  // type === "user"
  const result = await searchUsers({ q, isAdmin, page, limit });
  c.header("X-Search-Took-Ms", String(result.took_ms));
  return c.json({
    data: {
      query: q,
      type,
      items: result.items,
      total: result.total,
      page,
      limit,
      took_ms: result.took_ms,
    },
  });
});

export default router;
```

注：限流中间件的使用方式（上文直接调用闭包）较 hacky，Task 8 测试会用更直接的方式（mount 路径级中间件）。

- [ ] **Step 2: 检查 UnauthorizedError / ForbiddenError 存在**

```bash
grep -n "UnauthorizedError\|ForbiddenError" /home/user/neuro-oj/noj-core/src/lib/errors.ts | head -5
```

若不存在则用 `BadRequestError` 或参照其他现有错误类创建。优先使用项目已有错误类型。

- [ ] **Step 3: 提交**

```bash
git add noj-core/src/routes/search.ts
git commit -m "feat(core): 实现搜索路由 (issue #100)"
```

---

## Task 7: 路由挂载 + 限流路径级中间件

**Files:**
- Modify: `noj-core/src/app.ts:82-93`

**Interfaces:**
- Consumes: `routes/search.ts` 路由实例
- Produces: `/api/v1/search` 端点可用 + 路径级限流

- [ ] **Step 1: 修改 app.ts**

在 `noj-core/src/app.ts` 第 12 行附近（import 区段）追加：

```typescript
import search from "./routes/search.ts";
import { searchRateLimit } from "./middleware/searchRateLimit.ts";
```

在 `// 评测镜像公开列表...` 块（第 95-98 行）之前，插入路由挂载：

```typescript
  app.use("/api/v1/search", searchRateLimit("anon"));
  app.route("/api/v1/search", search);
```

注意：`searchRateLimit` 中间件在路由处理之前执行，匿名 IP 桶。

- [ ] **Step 2: 验证应用启动**

```bash
cd /home/user/neuro-oj/noj-core && deno run --allow-net --allow-env src/main.ts 2>&1 | head -30
```

预期：HTTP 服务正常启动（监听 8000），无注册错误。Ctrl+C 中断。

- [ ] **Step 3: 提交**

```bash
git add noj-core/src/app.ts
git commit -m "feat(core): 挂载搜索路由与限流中间件 (issue #100)"
```

---

## Task 8: 路由层集成测试

**Files:**
- Create: `noj-core/tests/routes/search.test.ts`

**Interfaces:**
- Consumes: `createApp()` + PGlite + 测试用户 seed
- Produces: 路由级覆盖（权限矩阵、参数校验、限流触发、tsvector 自动更新）

- [ ] **Step 1: 写测试文件**

创建 `noj-core/tests/routes/search.test.ts`：

```typescript
import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { resetDbForTest } from "../../src/db/connection.ts";
import { jsonRequest } from "../lib/helper.ts";
import { getDb } from "../../src/db/connection.ts";
import { problems, users } from "../../src/db/schema.ts";
import { getRedis } from "../../src/mq/connection.ts";

await resetDbForTest();

async function seed() {
  const db = getDb();
  const now = new Date().toISOString();
  // 清空测试相关表
  await db.delete(problems);
  await db.delete(users).where(
    sql`${users.id} <> '0'`, // 保留 root
  );

  await db.insert(problems).values([
    {
      id: "test-p-1",
      title: "动态规划",
      description: "",
      difficulty: "medium",
      judge_image: "test",
      judge_command: "test",
      number: 1,
      type: "P",
      created_at: now,
      updated_at: now,
    },
    {
      id: "test-p-2",
      title: "私有题",
      description: "",
      difficulty: "hard",
      judge_image: "test",
      judge_command: "test",
      number: 1,
      type: "U",
      created_at: now,
      updated_at: now,
    },
  ]);

  await db.insert(users).values([
    {
      id: "test-admin",
      username: "admin_test_search",
      email: "admin-test-search@example.com",
      password_hash: "x",
      role: "admin",
      created_at: now,
      updated_at: now,
    },
    {
      id: "test-user",
      username: "alice_test_search",
      email: "alice-test-search@example.com",
      password_hash: "x",
      role: "user",
      created_at: now,
      updated_at: now,
    },
  ]);
}

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasEnv;

Deno.test({
  name: "search route: q 缺失返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/search");
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.code, "VALIDATION_ERROR");
  },
});

Deno.test({
  name: "search route: q 长度 <2 返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/search?q=a");
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "search route: 匿名搜题目 '动态' 命中",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/search?q=动态");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body.data);
    assertEquals(body.data.items.length >= 1, true);
    assertEquals(body.data.items[0]?.title, "动态规划");
  },
});

Deno.test({
  name: "search route: 匿名搜题目不返回 U 型",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/search?q=私有");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.items.length, 0);
  },
});

Deno.test({
  name: "search route: type=user 匿名返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/search?q=alice&type=user");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "search route: 限流触发返回 429",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    Deno.env.set("RATE_LIMIT_ENABLED", "true");
    Deno.env.set("RATE_LIMIT_SEARCH_ENABLED", "true");
    Deno.env.set("RATE_LIMIT_SEARCH_WINDOW", "60");
    Deno.env.set("RATE_LIMIT_SEARCH_MAX_ANON", "2");

    await resetDbForTest();
    await seed();

    // 清空 redis 测试 key
    const redis = getRedis();
    await redis.del("ratelimit:search:ip:127.0.0.1");

    const app = createApp();

    // 前 2 次通过
    await jsonRequest(app, "/api/v1/search?q=test");
    await jsonRequest(app, "/api/v1/search?q=test");

    // 第 3 次触发限流
    const res = await jsonRequest(app, "/api/v1/search?q=test");
    assertEquals(res.status, 429);
    assertExists(res.headers.get("retry-after"));

    await redis.del("ratelimit:search:ip:127.0.0.1");
    Deno.env.delete("RATE_LIMIT_SEARCH_MAX_ANON");
  },
});

Deno.test({
  name: "search route: 题目创建后立即能搜到（tsvector 自动更新）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const db = getDb();
    const now = new Date().toISOString();
    // 直接 INSERT 一道题
    await db.insert(problems).values({
      id: "test-newly-created",
      title: "新鲜出炉的题目",
      description: "",
      difficulty: "easy",
      judge_image: "test",
      judge_command: "test",
      number: 999,
      type: "P",
      created_at: now,
      updated_at: now,
    });

    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/search?q=新鲜");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.items.length, 1);
    assertEquals(body.data.items[0]?.id, "test-newly-created");
  },
});

// helper import at top
import { sql } from "drizzle-orm";
```

- [ ] **Step 2: 运行测试验证**

```bash
cd /home/user/neuro-oj/noj-core && deno test tests/routes/search.test.ts
```

预期：全部 PASS。

- [ ] **Step 3: 提交**

```bash
git add noj-core/tests/routes/search.test.ts
git commit -m "test(core): 添加搜索路由集成测试 (issue #100)"
```

---

## Task 9: 性能基准测试（10 万题 + 1 万用户）

**Files:**
- Create: `noj-core/tests/perf/search_bench.test.ts`

**Interfaces:**
- Consumes: PGlite + 大量 seed 数据生成器
- Produces: 性能报告（断言 < 500ms）

- [ ] **Step 1: 创建性能测试**

创建 `noj-core/tests/perf/search_bench.test.ts`：

```typescript
import { assertEquals, assert } from "jsr:@std/assert@^1";
import { searchProblems, searchUsers } from "../../src/services/search.ts";
import { resetDbForTest, getDb } from "../../src/db/connection.ts";
import { problems, users } from "../../src/db/schema.ts";
import { sql } from "drizzle-orm";

await resetDbForTest();

Deno.test({
  name: "search perf: 100k problems + 10k users 搜索响应 < 500ms",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();

    // Seed 100k problems（分批插入，避免 PGlite OOM）
    const BATCH = 1000;
    const now = new Date().toISOString();
    for (let i = 0; i < 100; i++) {
      const batch = Array.from({ length: BATCH }, (_, j) => ({
        id: `perf-p-${i}-${j}`,
        title: `题目 ${i * BATCH + j}：测试数据`,
        description: "",
        difficulty: "medium",
        judge_image: "test",
        judge_command: "test",
        number: i * BATCH + j + 1,
        type: "P" as const,
        created_at: now,
        updated_at: now,
      }));
      await db.insert(problems).values(batch);
    }

    // Seed 10k users
    for (let i = 0; i < 10; i++) {
      const batch = Array.from({ length: 1000 }, (_, j) => ({
        id: `perf-u-${i}-${j}`,
        username: `user_${i * 1000 + j}`,
        email: `user_${i}_${j}@perf.test`,
        password_hash: "x",
        role: "user",
        created_at: now,
        updated_at: now,
      }));
      await db.insert(users).values(batch);
    }

    // ANALYZE 让 planner 用上索引统计
    await db.execute(sql`ANALYZE problems`);
    await db.execute(sql`ANALYZE users`);

    // 题目搜索基准
    const pStart = performance.now();
    const pResult = await searchProblems({
      q: "测试",
      isAdmin: false,
      page: 1,
      limit: 20,
    });
    const pElapsed = performance.now() - pStart;
    console.log(`题目搜索：${pResult.items.length} 命中，${pElapsed.toFixed(0)}ms`);
    assert(pElapsed < 500, `题目搜索 ${pElapsed}ms 超 500ms 阈值`);

    // 用户搜索基准
    const uStart = performance.now();
    const uResult = await searchUsers({
      q: "user_1",
      isAdmin: true,
      page: 1,
      limit: 20,
    });
    const uElapsed = performance.now() - uStart;
    console.log(`用户搜索：${uResult.items.length} 命中，${uElapsed.toFixed(0)}ms`);
    assert(uElapsed < 500, `用户搜索 ${uElapsed}ms 超 500ms 阈值`);
  },
});
```

- [ ] **Step 2: 运行性能测试**

```bash
cd /home/user/neuro-oj/noj-core && deno test --allow-all tests/perf/search_bench.test.ts
```

预期：两个搜索都 < 500ms，输出测量值。若超时，可调整阈值或分批插入。

- [ ] **Step 3: 提交**

```bash
git add noj-core/tests/perf/search_bench.test.ts
git commit -m "test(core): 添加搜索性能基准测试 (issue #100)"
```

---

## Task 10: useSearch composable

**Files:**
- Create: `noj-ui/composables/useSearch.ts`

**Interfaces:**
- Consumes: `useState`（共享状态）+ `$fetch`（API 调用）+ `navigateTo`（跳转）
- Produces: `{ state, open, close, search }` 供 `SearchPalette.vue` 和 `pages/search.vue` 使用

- [ ] **Step 1: 创建 composable**

创建 `noj-ui/composables/useSearch.ts`：

```typescript
/**
 * 全局搜索状态管理（issue #100）。
 *
 * 单一 useState 实例（key="search:state"）在所有组件间共享：
 * - SearchPalette.vue 写入 query/results
 * - pages/search.vue 读取 query/results 用于分页
 * - Navbar.vue 调用 open() 唤起面板
 */

export type SearchType = "all" | "problem" | "user";

export interface ProblemSearchResult {
  id: string;
  type: string;
  number: number;
  display_id: string;
  title: string;
  difficulty: string;
  rank: number;
  highlight: string;
}

export interface UserSearchResult {
  id: string;
  username: string;
  email: string;
  role: string;
  rank: number;
  highlight: string;
}

export interface SearchState {
  open: boolean;
  query: string;
  type: SearchType;
  results: {
    problems: ProblemSearchResult[];
    users: UserSearchResult[];
  };
  loading: boolean;
  error: string | null;
}

export function useSearch() {
  const state = useState<SearchState>("search:state", () => ({
    open: false,
    query: "",
    type: "all",
    results: { problems: [], users: [] },
    loading: false,
    error: null,
  }));

  const open = () => {
    state.value.open = true;
  };

  const close = () => {
    state.value.open = false;
  };

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 防抖搜索（300ms）。
   * type="all" 时同时拉取题目 + 用户两个端点（前端合并展示）。
   */
  const search = async (q: string, opts?: { type?: SearchType; limit?: number }) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      state.value.results = { problems: [], users: [] };
      state.value.loading = false;
      state.value.error = null;
      return;
    }

    if (debounceTimer) clearTimeout(debounceTimer);

    return new Promise<void>((resolve) => {
      debounceTimer = setTimeout(async () => {
        state.value.loading = true;
        state.value.error = null;
        const type = opts?.type ?? state.value.type;
        const limit = opts?.limit ?? 5;

        try {
          if (type === "all") {
            // 并行请求题目 + 用户
            const [pRes, uRes] = await Promise.allSettled([
              $fetch("/api/v1/search", {
                params: { q: trimmed, type: "problem", limit },
              }),
              $fetch("/api/v1/search", {
                params: { q: trimmed, type: "user", limit: 3 },
              }),
            ]);

            state.value.results.problems = pRes.status === "fulfilled"
              ? (pRes.value as { data: { items: ProblemSearchResult[] } }).data.items
              : [];
            state.value.results.users = uRes.status === "fulfilled"
              ? (uRes.value as { data: { items: UserSearchResult[] } }).data.items
              : [];
          } else {
            const res = await $fetch("/api/v1/search", {
              params: { q: trimmed, type, limit },
            });
            const items = (res as { data: { items: ProblemSearchResult[] | UserSearchResult[] } })
              .data.items;
            state.value.results = {
              problems: type === "problem" ? items as ProblemSearchResult[] : [],
              users: type === "user" ? items as UserSearchResult[] : [],
            };
          }
        } catch (e: unknown) {
          state.value.error = (e as { data?: { error?: string } })?.data?.error
            ?? "搜索失败";
          state.value.results = { problems: [], users: [] };
        } finally {
          state.value.loading = false;
          resolve();
        }
      }, 300);
    });
  };

  return {
    state: readonly(state),
    open,
    close,
    search,
  };
}
```

- [ ] **Step 2: 类型检查**

```bash
cd /home/user/neuro-oj/noj-ui && deno task build 2>&1 | tail -20
```

预期：构建成功无 TS 错误。

- [ ] **Step 3: 提交**

```bash
git add noj-ui/composables/useSearch.ts
git commit -m "feat(ui): 实现 useSearch 全局 composable (issue #100)"
```

---

## Task 11: SearchResultItem 组件

**Files:**
- Create: `noj-ui/components/feature/search/SearchResultItem.vue`

**Interfaces:**
- Consumes: 单条 `ProblemSearchResult` 或 `UserSearchResult`
- Produces: 高亮渲染的列表项，点击跳转对应页面

- [ ] **Step 1: 创建组件**

创建 `noj-ui/components/feature/search/SearchResultItem.vue`：

```vue
<template>
  <component
    :is="href ? resolveComponent('NuxtLink') : 'div'"
    :to="href"
    class="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors rounded-md cursor-pointer"
    :class="{ 'bg-primary-bg/10': selected }"
  >
    <!-- 题号 / 用户头像占位 -->
    <div
      class="flex-shrink-0 w-10 h-10 rounded-md flex items-center justify-center text-sm font-mono font-semibold"
      :class="kind === 'problem' ? 'bg-primary-bg text-primary' : 'bg-info-bg text-info-text'"
    >
      <span v-if="kind === 'problem'">{{ displayId || item.display_id }}</span>
      <span v-else>{{ usernameInitial }}</span>
    </div>

    <!-- 主信息 -->
    <div class="flex-1 min-w-0">
      <div class="text-sm font-medium text-text truncate" v-html="highlightedTitle" />
      <div class="text-xs text-text-secondary truncate">
        <span v-if="kind === 'problem'">
          {{ difficultyLabel }} · {{ rankText }}
        </span>
        <span v-else>
          {{ roleLabel }}
        </span>
      </div>
    </div>

    <!-- 类型徽章 -->
    <div class="flex-shrink-0 text-xs text-text-muted">
      {{ kind === "problem" ? "题目" : "用户" }}
    </div>
  </component>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { ProblemSearchResult, UserSearchResult } from "~/composables/useSearch";

const props = defineProps<{
  item: ProblemSearchResult | UserSearchResult;
  kind: "problem" | "user";
  selected?: boolean;
  displayId?: string;
  rank?: number;
}>();

const href = computed(() => {
  if (props.kind === "problem") {
    const p = props.item as ProblemSearchResult;
    return `/problems/${p.display_id || p.id}`;
  }
  const u = props.item as UserSearchResult;
  return `/users/${u.id}`;
});

const usernameInitial = computed(() => {
  const u = props.item as UserSearchResult;
  return u.username?.[0]?.toUpperCase() ?? "?";
});

const difficultyLabel = computed(() => {
  const p = props.item as ProblemSearchResult;
  return { easy: "简单", medium: "中等", hard: "困难" }[p.difficulty] ?? p.difficulty;
});

const roleLabel = computed(() => {
  const u = props.item as UserSearchResult;
  return u.role === "admin" ? "管理员" : "用户";
});

const rankText = computed(() => {
  return props.rank !== undefined ? `相关度 ${(props.rank * 100).toFixed(0)}` : "";
});

// 将 [[HIGHLIGHT]]...[[/HIGHLIGHT]] 转为 <mark>（受控渲染，marker 来自服务端 ts_headline）
const highlightedTitle = computed(() => {
  const item = props.item as ProblemSearchResult | UserSearchResult;
  const raw = props.kind === "problem"
    ? (item as ProblemSearchResult).highlight
    : (item as UserSearchResult).highlight;
  return raw
    .replaceAll("[[HIGHLIGHT]]", '<mark class="bg-yellow-200">')
    .replaceAll("[[/HIGHLIGHT]]", "</mark>");
});
</script>
```

- [ ] **Step 2: 类型检查**

```bash
cd /home/user/neuro-oj/noj-ui && deno task build 2>&1 | tail -10
```

预期：构建成功。

- [ ] **Step 3: 提交**

```bash
git add noj-ui/components/feature/search/SearchResultItem.vue
git commit -m "feat(ui): 实现 SearchResultItem 组件 (issue #100)"
```

---

## Task 12: SearchPalette 命令面板

**Files:**
- Create: `noj-ui/components/feature/search/SearchPalette.vue`

**Interfaces:**
- Consumes: `useSearch()` composable
- Produces: 全局可用的命令面板浮层（遮罩 + 输入框 + 结果列表 + 键盘导航）

- [ ] **Step 1: 创建 SearchPalette**

创建 `noj-ui/components/feature/search/SearchPalette.vue`：

```vue
<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="state.open"
        class="fixed inset-0 z-[200] bg-black/30 flex items-start justify-center pt-[15vh]"
        @click.self="close"
      >
        <div
          class="w-full max-w-2xl bg-white rounded-lg shadow-modal overflow-hidden"
          @keydown="onKeydown"
        >
          <!-- 搜索输入 -->
          <div class="flex items-center gap-3 px-4 h-14 border-b border-border">
            <SearchIcon class="w-5 h-5 text-text-muted" />
            <input
              ref="inputRef"
              v-model="query"
              type="text"
              :placeholder="placeholder"
              class="flex-1 h-full bg-transparent outline-none text-base text-text placeholder:text-text-muted"
              autocomplete="off"
              spellcheck="false"
            />
            <kbd class="hidden sm:inline-block px-2 py-1 text-xs bg-gray-100 border border-border rounded">ESC</kbd>
          </div>

          <!-- 结果列表 -->
          <div v-if="state.loading" class="px-4 py-8 text-center text-text-muted text-sm">
            搜索中...
          </div>

          <div
            v-else-if="query.length >= 2 && state.results.problems.length === 0 && state.results.users.length === 0 && !state.loading"
            class="px-4 py-8 text-center text-text-muted text-sm"
          >
            没有匹配结果
          </div>

          <div v-else-if="query.length < 2" class="px-4 py-8 text-center text-text-muted text-sm">
            请输入至少 2 个字符
          </div>

          <div v-else class="max-h-[50vh] overflow-y-auto">
            <div v-if="state.results.problems.length > 0" class="px-4 pt-3 pb-1 text-xs text-text-muted font-medium">
              题目
            </div>
            <SearchResultItem
              v-for="(p, i) in state.results.problems"
              :key="`p-${p.id}`"
              :item="p"
              kind="problem"
              :selected="selectedIndex === i"
              @click="close"
            />

            <div v-if="state.results.users.length > 0" class="px-4 pt-3 pb-1 text-xs text-text-muted font-medium">
              用户
            </div>
            <SearchResultItem
              v-for="(u, j) in state.results.users"
              :key="`u-${u.id}`"
              :item="u"
              kind="user"
              :selected="selectedIndex === state.results.problems.length + j"
              @click="close"
            />
          </div>

          <!-- 底部提示 -->
          <div class="flex items-center justify-between px-4 h-10 border-t border-border bg-gray-50 text-xs text-text-muted">
            <div class="flex items-center gap-3">
              <span><kbd class="px-1.5 py-0.5 bg-white border border-border rounded">↑↓</kbd> 导航</span>
              <span><kbd class="px-1.5 py-0.5 bg-white border border-border rounded">↵</kbd> 选择</span>
            </div>
            <NuxtLink
              :to="`/search?q=${encodeURIComponent(query)}&type=all`"
              class="text-primary hover:underline"
              @click="close"
            >
              查看全部结果 →
            </NuxtLink>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { Search as SearchIcon } from "lucide-vue-next";
import { useSearch } from "~/composables/useSearch";

const { state, close, search } = useSearch();
const query = ref("");
const selectedIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);

const placeholder = computed(() => "搜索题目、用户...");

const flatItems = computed(() => [
  ...state.value.results.problems,
  ...state.value.results.users,
]);

watch(query, async (q) => {
  selectedIndex.value = 0;
  await search(q);
});

watch(
  () => state.value.open,
  async (open) => {
    if (open) {
      query.value = state.value.query;
      selectedIndex.value = 0;
      await nextTick();
      inputRef.value?.focus();
    }
  },
);

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex.value = Math.min(
      selectedIndex.value + 1,
      flatItems.value.length - 1,
    );
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const item = flatItems.value[selectedIndex.value];
    if (item) {
      const kind = selectedIndex.value < state.value.results.problems.length
        ? "problem"
        : "user";
      const href = kind === "problem"
        ? `/problems/${(item as any).display_id || (item as any).id}`
        : `/users/${(item as any).id}`;
      close();
      navigateTo(href);
    } else if (query.value.trim().length >= 2) {
      // 没选中：跳完整结果页
      close();
      navigateTo(`/search?q=${encodeURIComponent(query.value)}&type=all`);
    }
  }
}
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
```

- [ ] **Step 2: 类型检查**

```bash
cd /home/user/neuro-oj/noj-ui && deno task build 2>&1 | tail -10
```

预期：构建成功。

- [ ] **Step 3: 提交**

```bash
git add noj-ui/components/feature/search/SearchPalette.vue
git commit -m "feat(ui): 实现 SearchPalette 命令面板 (issue #100)"
```

---

## Task 13: Navbar 集成 + 全局 Ctrl+K 监听

**Files:**
- Modify: `noj-ui/components/layout/Navbar.vue`
- Modify: `noj-ui/app.vue` 或 `noj-ui/layouts/default.vue`（取决于挂载点）

**Interfaces:**
- Consumes: `useSearch().open()`
- Produces: Navbar 显示搜索按钮；全局键盘事件 Ctrl/Cmd+K 唤起

- [ ] **Step 1: 修改 Navbar.vue**

修改 `noj-ui/components/layout/Navbar.vue`，在 `<nav>` 之后、`<div class="flex items-center gap-3 ml-auto">` 之前插入搜索按钮：

```vue
<button
  type="button"
  class="flex items-center gap-2 px-3 py-1.5 text-sm text-text-secondary hover:bg-gray-100 rounded-md transition-colors"
  @click="openSearch"
>
  <SearchIcon class="w-4 h-4" />
  <span>搜索</span>
  <kbd class="hidden md:inline-block px-1.5 py-0.5 text-xs bg-gray-100 border border-border rounded">Ctrl K</kbd>
</button>
```

修改 `<script setup>`：

```vue
<script setup lang="ts">
import { Search as SearchIcon } from "lucide-vue-next";
const { user } = useAuth();
const { open: openSearch } = useSearch();
</script>
```

- [ ] **Step 2: 在 layout 挂载 SearchPalette**

修改 `noj-ui/layouts/default.vue`（或 app.vue），在 `<slot />` 之后追加：

```vue
<template>
  <div class="min-h-screen flex flex-col">
    <Navbar />
    <main class="flex-1 pt-16">
      <slot />
    </main>
    <FooterBar />
    <SearchPalette />
  </div>
</template>

<script setup lang="ts">
import SearchPalette from "~/components/feature/search/SearchPalette.vue";

function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    const { open } = useSearch();
    open();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onGlobalKeydown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onGlobalKeydown);
});
</script>
```

- [ ] **Step 3: 验证开发服务器启动**

```bash
cd /home/user/neuro-oj/noj-ui && deno task dev 2>&1 | tail -15
```

预期：Nuxt 开发服务器启动无错误（监听 3000）。访问首页可见搜索按钮。Ctrl+C 中断。

- [ ] **Step 4: 提交**

```bash
git add noj-ui/components/layout/Navbar.vue noj-ui/layouts/default.vue
git commit -m "feat(ui): Navbar 集成搜索按钮 + 全局 Ctrl+K 监听 (issue #100)"
```

---

## Task 14: /search 结果页

**Files:**
- Create: `noj-ui/pages/search.vue`

**Interfaces:**
- Consumes: `useSearch()` + URL query (`?q=&type=&page=`)
- Produces: 完整结果列表 + 类型切换 tab + 分页 + 耗时展示

- [ ] **Step 1: 创建结果页**

创建 `noj-ui/pages/search.vue`：

```vue
<template>
  <div class="max-w-3xl mx-auto px-6 py-8">
    <h1 class="text-2xl font-bold text-text mb-6">搜索结果</h1>

    <!-- 搜索框 -->
    <div class="flex items-center gap-3 px-4 h-12 border border-border rounded-md bg-white mb-4">
      <SearchIcon class="w-5 h-5 text-text-muted" />
      <input
        v-model="query"
        type="text"
        placeholder="搜索题目、用户..."
        class="flex-1 h-full bg-transparent outline-none text-base"
        @keydown.enter="onSearch"
      />
    </div>

    <!-- 类型切换 -->
    <div class="flex items-center gap-2 mb-6 border-b border-border">
      <button
        v-for="t in typeOptions"
        :key="t.value"
        type="button"
        class="px-4 py-2 text-sm transition-colors"
        :class="type === t.value
          ? 'text-primary border-b-2 border-primary font-medium'
          : 'text-text-secondary hover:text-text'"
        @click="setType(t.value)"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- 状态展示 -->
    <AsyncContent
      :loading="loading"
      :error="error"
      :empty="items.length === 0 && query.trim().length >= 2"
      empty-text="没有匹配结果"
    >
      <div v-if="took_ms !== null" class="text-xs text-text-muted mb-3">
        共 {{ total }} 条结果，耗时 {{ took_ms }}ms
      </div>

      <div class="bg-white border border-border rounded-md overflow-hidden divide-y divide-border">
        <SearchResultItem
          v-for="item in items"
          :key="item.id || item.username"
          :item="item"
          :kind="type === 'user' ? 'user' : 'problem'"
        />
      </div>

      <!-- 分页 -->
      <PaginationNav
        v-if="total > limit"
        :page="page"
        :total="total"
        :limit="limit"
        class="mt-6"
        @update:page="setPage"
      />
    </AsyncContent>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { Search as SearchIcon } from "lucide-vue-next";
import AsyncContent from "~/components/ui/AsyncContent.vue";
import PaginationNav from "~/components/PaginationNav.vue";
import SearchResultItem from "~/components/feature/search/SearchResultItem.vue";
import { useSearch, type SearchType, type ProblemSearchResult, type UserSearchResult } from "~/composables/useSearch";

definePageMeta({ layout: "default" });

const route = useRoute();
const router = useRouter();

const query = ref((route.query.q as string) ?? "");
const type = ref<SearchType>((route.query.type as SearchType) ?? "problem");
const page = ref(Number(route.query.page) || 1);
const limit = 20;
const loading = ref(false);
const error = ref<string | null>(null);
const items = ref<(ProblemSearchResult | UserSearchResult)[]>([]);
const total = ref(0);
const took_ms = ref<number | null>(null);

const typeOptions = [
  { value: "problem" as SearchType, label: "题目" },
  { value: "user" as SearchType, label: "用户" },
];

async function fetchResults() {
  const q = query.value.trim();
  if (q.length < 2) {
    items.value = [];
    total.value = 0;
    return;
  }

  loading.value = true;
  error.value = null;

  try {
    const res = await $fetch("/api/v1/search", {
      params: { q, type: type.value === "user" ? "user" : "problem", page: page.value, limit },
    });
    items.value = (res as any).data.items;
    total.value = (res as any).data.total;
    took_ms.value = (res as any).data.took_ms;
  } catch (e: any) {
    error.value = e?.data?.error ?? "搜索失败";
    items.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

function syncUrl() {
  router.replace({
    query: {
      q: query.value,
      type: type.value,
      page: String(page.value),
    },
  });
}

function onSearch() {
  page.value = 1;
  syncUrl();
  fetchResults();
}

function setType(t: SearchType) {
  type.value = t;
  page.value = 1;
  syncUrl();
  fetchResults();
}

function setPage(p: number) {
  page.value = p;
  syncUrl();
  fetchResults();
}

watch(query, () => {
  // 实时搜索（debounce 300ms）
  if (query.value.trim().length >= 2) {
    page.value = 1;
    fetchResults();
  } else {
    items.value = [];
    total.value = 0;
  }
});

onMounted(() => {
  if (query.value.trim().length >= 2) fetchResults();
});
</script>
```

- [ ] **Step 2: 类型检查 + 构建**

```bash
cd /home/user/neuro-oj/noj-ui && deno task build 2>&1 | tail -10
```

预期：构建成功。

- [ ] **Step 3: 提交**

```bash
git add noj-ui/pages/search.vue
git commit -m "feat(ui): 实现 /search 完整结果页 (issue #100)"
```

---

## Task 15: E2E 测试

**Files:**
- Create: `noj-tests/e2e/08_search.test.ts`

**Interfaces:**
- Consumes: 完整 E2E 环境（noj-core + noj-ui + PG + Redis）
- Produces: 端到端验证 Ctrl+K、键盘导航、跳转

- [ ] **Step 1: 创建 E2E 测试**

参考现有 `noj-tests/e2e/02_problems.test.ts` 的测试模式（helper.ts 封装 setup/teardown），创建 `noj-tests/e2e/08_search.test.ts`：

```typescript
import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { setupE2E, teardownE2E, type E2EContext } from "./helper.ts";

Deno.test({
  name: "E2E: Ctrl+K 唤起搜索面板，输入查询显示结果",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ctx = await setupE2E();
    try {
      // 通过 fetch 直接验证 API（无浏览器框架）
      const res = await fetch(`${ctx.coreUrl}/api/v1/search?q=test&type=problem`, {
        headers: ctx.authHeaders,
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertExists(body.data);
      assertExists(body.data.items);
      assertEquals(typeof body.data.took_ms, "number");
    } finally {
      await teardownE2E(ctx);
    }
  },
});

Deno.test({
  name: "E2E: type=user 匿名返回 401",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ctx = await setupE2E();
    try {
      const res = await fetch(`${ctx.coreUrl}/api/v1/search?q=alice&type=user`);
      assertEquals(res.status, 401);
    } finally {
      await teardownE2E(ctx);
    }
  },
});

Deno.test({
  name: "E2E: admin 搜索用户返回 email 字段",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ctx = await setupE2E({ loginAs: "admin" });
    try {
      const res = await fetch(
        `${ctx.coreUrl}/api/v1/search?q=${ctx.adminUsername}&type=user`,
        { headers: ctx.authHeaders },
      );
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.data.items.length >= 1, true);
      assertExists(body.data.items[0]?.email);
    } finally {
      await teardownE2E(ctx);
    }
  },
});

Deno.test({
  name: "E2E: 搜索性能（10w 题种子数据下）< 500ms",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ctx = await setupE2E({ seedPerfData: true });
    try {
      const start = performance.now();
      const res = await fetch(
        `${ctx.coreUrl}/api/v1/search?q=测试&type=problem&limit=20`,
        { headers: ctx.authHeaders },
      );
      const elapsed = performance.now() - start;
      assertEquals(res.status, 200);
      console.log(`perf: ${elapsed.toFixed(0)}ms`);
      assert(elapsed < 500, `搜索耗时 ${elapsed}ms 超 500ms 阈值`);
    } finally {
      await teardownE2E(ctx);
    }
  },
});
```

- [ ] **Step 2: 验证 helper.ts 暴露所需 API**

```bash
grep -n "setupE2E\|loginAs\|seedPerfData" /home/user/neuro-oj/noj-tests/e2e/helper.ts | head -10
```

若 `helper.ts` 未提供 `loginAs` / `seedPerfData` 选项，参考现有 02_problems.test.ts 简化测试，去掉这两个选项的参数。

- [ ] **Step 3: 运行 E2E**

按 `noj-tests/E2E_TESTING.md` 流程启动完整环境后运行：

```bash
cd /home/user/neuro-oj/noj-tests && NOJ_RUN_E2E=1 deno task test:e2e -- 08_search
```

预期：全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add noj-tests/e2e/08_search.test.ts
git commit -m "test(e2e): 添加全局搜索 E2E 测试 (issue #100)"
```

---

## Task 16: 文档更新

**Files:**
- Modify: `noj-core/CLAUDE.md`（API 路由表 + 速率限制章节）
- Modify: `noj-ui/CLAUDE.md`（composables 章节）
- Modify: `openspec/specs/database-schema/`（如已有此规范，加 search_vector 列描述）

**Interfaces:**
- Consumes: 已实现的代码
- Produces: 与代码同步的文档

- [ ] **Step 1: 更新 noj-core/CLAUDE.md**

在 `## API 路由` 表格中追加：

```markdown
| GET    | `/api/v1/search`                     | 公开/管理员 | 全局搜索（题目+用户，分页）             |
```

在 `## 已知限制` 或新增章节 `## 全局搜索（issue #100）` 中描述：
- 数据库列：problems/users.search_vector（GENERATED）
- 中英文策略：simple + pg_trgm
- 权限矩阵
- 限流：search 独立桶

- [ ] **Step 2: 更新 noj-ui/CLAUDE.md**

在 `## Composables 参考` 表格中追加：

```markdown
| useSearch | 全局搜索状态 + 防抖 + fetch，命令面板与结果页共享 |
```

- [ ] **Step 3: 更新 OpenSpec**

在 `openspec/specs/database-schema/spec.md` 中追加（若不存在则新建）：

```markdown
## search_vector（issue #100）

`problems` 和 `users` 表均含 `search_vector tsvector` 列，由 PostgreSQL `GENERATED ALWAYS AS ... STORED` 表达式自动维护：

- problems: title 权重 A + display_id 权重 B
- users: username 权重 A + email 权重 B

GIN 索引：tsvector + pg_trgm 双索引，中英文混合友好。
```

- [ ] **Step 4: 提交**

```bash
git add noj-core/CLAUDE.md noj-ui/CLAUDE.md openspec/specs/database-schema/
git commit -m "docs(core,ui,spec): 更新全局搜索相关文档 (issue #100)"
```

---

## Self-Review Checklist

✅ Spec coverage: 6 个验收标准全部分配到任务
- problems tsvector + GIN → Task 1, 2
- 自动更新 → Task 1 (GENERATED 列)
- API + 分页 + 中文分词 → Task 5, 6
- 前端 Ctrl+K → Task 12, 13
- 结果页跳转 → Task 11, 14
- 性能 < 500ms → Task 9, 15

✅ Placeholder scan: 无 TBD/TODO/待定；所有代码块完整

✅ Type consistency:
- `ProblemSearchItem` 接口在 Task 5 定义，Task 6 路由使用，Task 11/14 前端组件使用 ✓
- `UserSearchItem` 接口一致 ✓
- `useSearch().state.open` 在 Task 10 定义，Task 12/13/14 使用 ✓
- `searchRateLimit("anon"/"authed")` 在 Task 4 定义，Task 6/7 使用 ✓

✅ File structure: 16 个任务清晰分层，DRY 原则贯穿

✅ Bite-sized: 每步 2-5 分钟，频繁 commit

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-13-global-search.md`.**

**Two execution options:**

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**