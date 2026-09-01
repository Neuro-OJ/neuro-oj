# noj-core Schema 拆分与 LLM 表所有权迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 noj-core 的 `schema.ts` 按域拆分，并把 LLM 三表（`llm_providers` / `llm_usage` / `llm_quotas`）的 DDL/迁移/种子所有权移交给 noj-llm-gateway，同时保持数据库物理表结构不变。

**Architecture:** 采用“同库逻辑所有权转移”：core 的 Drizzle schema 按域拆成多文件；LLM 三表仍留在同一个 PostgreSQL public schema，但由 noj-llm-gateway 通过自己的迁移 runner 和启动 seed 接管；core 删除 LLM 表定义、删除 `submissions.llm_provider_config_id` 外键、移除 `seedLlmQuotas`。

**Tech Stack:** Deno 2、Drizzle ORM、postgres.js、jj、GPG 签名提交。

**Spec:** `dev-docs/superpowers/specs/2026-09-01-noj-core-schema-split-and-llm-ownership-design.md`

## Global Constraints

- 所有提交必须 GPG 签名；使用 jj 提交，提交信息为中文 Conventional Commits。
- 禁止手动修改 `_journal.json`；迁移只能追加。
- 禁止手动修改 `deno.lock` / `Cargo.lock`；若 `deno.lock` 被工具改动，提交前用 `jj restore` 还原。
- 代码必须通过 `deno fmt` / `deno lint` / `deno check`。
- 测试必须通过 `deno task` 运行，优先 `deno task test:parallel`。
- 搜索使用 `rg`，不使用 `grep`。
- 本计划不改变 LLM 三表的物理结构，不引入独立 Postgres schema 或独立数据库。

---

### Task 1: 拆分 noj-core schema.ts 为域文件

**Files:**
- Create: `noj-core/src/db/schema/common.ts`
- Create: `noj-core/src/db/schema/identity.ts`
- Create: `noj-core/src/db/schema/catalog.ts`
- Create: `noj-core/src/db/schema/objective.ts`
- Create: `noj-core/src/db/schema/submission.ts`
- Create: `noj-core/src/db/schema/contest.ts`
- Create: `noj-core/src/db/schema/community.ts`
- Create: `noj-core/src/db/schema/messaging.ts`
- Create: `noj-core/src/db/schema/system.ts`
- Create: `noj-core/src/db/schema/gateway.ts`
- Create: `noj-core/src/db/schema/index.ts`
- Modify: `noj-core/src/db/schema.ts`（改为 barrel 再导出）

**Interfaces:**
- Consumes: 现有 `noj-core/src/db/schema.ts` 中的全部表定义。
- Produces: `src/db/schema.ts` 继续导出全部表；`src/db/schema/index.ts` 作为域文件汇总。

- [ ] **Step 1: 创建 `common.ts`**

```ts
import { customType } from "drizzle-orm/pg-core";

/**
 * Postgres `tsvector` 列（用于全文搜索）。
 * Drizzle ORM 0.45.x 不导出原生 tsvector 列类型，使用 customType 注册一个。
 */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});
```

- [ ] **Step 2: 创建各域文件并移动表定义**

从 `noj-core/src/db/schema.ts` 中按下列清单**原样复制**对应的 `export const ... = pgTable(...)` 块到对应文件，并补上该文件所需的 import。

`identity.ts` 包含：`users`、`oauthAccounts`、`checkIns`、`passwordResetTokens`、`tfaRecoveryCodes`、`userBans`、`roles`、`permissions`、`rolePermissions`、`userRoles`

```ts
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tsvector } from "./common.ts";
```

`catalog.ts` 包含：`problems`、`tags`、`problemTags`、`trainings`、`trainingProblems`

```ts
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tsvector } from "./common.ts";
import { ROOT_USER_ID } from "../../lib/constants.ts";
```

`objective.ts` 包含：`objectiveQuestions`、`objectiveSubmissions`

```ts
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
```

`submission.ts` 包含：`submissions`、`evaluationResults`、`selfTests`、`sseEvents`

```ts
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { SubmissionStatus } from "../../types/index.ts";
import type { SelfTestStatus } from "../../types/self-tests.ts";
import { llmProviders } from "./gateway.ts";
```

> 注意：`submissions.llm_provider_config_id` 在 Task 1 阶段仍保留对 `llmProviders` 的 FK 引用；Task 3 会移除。

`contest.ts` 包含：`contests`、`contestProblems`、`contestParticipants`、`contestClarifications`

```ts
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
```

`community.ts` 包含：`communityBoards`、`communityBoardRoleGrants`、`communityPosts`、`communityComments`、`communityPostLikes`、`communityCommentLikes`、`communityBookmarks`、`communityFollows`、`communityActivityEvents`、`communityReports`、`communityModerationActions`、`communitySanctions`、`communityNotifications`

```ts
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
```

`messaging.ts` 包含：`conversations`、`messages`、`conversationReads`、`messageDeletions`

```ts
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
```

`system.ts` 包含：`judgeImages`、`systemSettings`、`announcements`、`auditLogs`、`ipBans`

```ts
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
```

`gateway.ts` 包含：`llmProviders`、`llmUsage`、`llmQuotas`

```ts
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
```

- [ ] **Step 3: 创建 `index.ts`**

```ts
export * from "./identity.ts";
export * from "./catalog.ts";
export * from "./objective.ts";
export * from "./submission.ts";
export * from "./contest.ts";
export * from "./community.ts";
export * from "./messaging.ts";
export * from "./system.ts";
export * from "./gateway.ts";
```

- [ ] **Step 4: 将 `schema.ts` 改为 barrel**

将 `noj-core/src/db/schema.ts` 全部内容替换为：

```ts
export * from "./schema/index.ts";
```

- [ ] **Step 5: 验证拆分前后 schema 等价**

运行：

```bash
cd noj-core
deno fmt
deno task check:types
deno task db:generate
```

预期：`db:generate` 输出 “No changes” 或等价提示，**不产生新迁移文件**。

- [ ] **Step 6: 运行域检查与测试**

```bash
cd noj-core
deno task check:domains
deno task test:smoke
```

预期：`check:domains` 0 违规；smoke 通过。

- [ ] **Step 7: 提交**

```bash
jj commit -m "refactor(core): 按域拆分 db schema 文件"
```

---

### Task 2: noj-llm-gateway 建立 Drizzle schema、迁移 runner 与默认配额 seed

**Files:**
- Create: `noj-llm-gateway/src/db/schema.ts`
- Create: `noj-llm-gateway/src/db/migrate.ts`
- Create: `noj-llm-gateway/src/db/migrate-cli.ts`
- Create: `noj-llm-gateway/src/db/seed.ts`
- Create: `noj-llm-gateway/drizzle/0000_baseline.sql`
- Create: `noj-llm-gateway/drizzle.config.ts`
- Modify: `noj-llm-gateway/src/main.ts`
- Modify: `noj-llm-gateway/deno.json`

**Interfaces:**
- Consumes: 现有 `noj-llm-gateway/src/db.ts` 的 `createDb`。
- Produces: `runMigrations(databaseUrl: string): Promise<void>`、`seedDefaultQuotas(db: Db): Promise<void>`；`main.ts` 启动时先迁移再 seed。

- [ ] **Step 1: 创建 `src/db/schema.ts`**

从 `noj-core/src/db/schema.ts` 原样复制 `llmProviders` / `llmUsage` / `llmQuotas` 三个表定义，文件头为：

```ts
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
```

- [ ] **Step 2: 创建 `drizzle/0000_baseline.sql`**

内容使用 `CREATE TABLE IF NOT EXISTS` 与 `CREATE INDEX IF NOT EXISTS`，与现有 public schema 表结构一致：

```sql
CREATE TABLE IF NOT EXISTS "llm_providers" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "base_url" text NOT NULL,
  "model" text NOT NULL,
  "cost_per_1k_tokens" double precision DEFAULT 0 NOT NULL,
  "encrypted_api_key" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_by" text DEFAULT '0' NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_usage" (
  "id" text PRIMARY KEY NOT NULL,
  "submission_id" text NOT NULL,
  "problem_id" text NOT NULL,
  "user_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "model" text NOT NULL,
  "request_messages" jsonb NOT NULL,
  "request_params" jsonb DEFAULT '{}' NOT NULL,
  "prompt_tokens" integer DEFAULT 0 NOT NULL,
  "completion_tokens" integer DEFAULT 0 NOT NULL,
  "total_tokens" integer DEFAULT 0 NOT NULL,
  "estimated_cost" integer DEFAULT 0 NOT NULL,
  "latency_ms" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'ok' NOT NULL,
  "error_code" text,
  "prompt_hash" text NOT NULL,
  "created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_quotas" (
  "id" text PRIMARY KEY NOT NULL,
  "scope_type" text NOT NULL,
  "scope_id" text DEFAULT '' NOT NULL,
  "window_type" text DEFAULT 'day' NOT NULL,
  "max_calls" integer DEFAULT 0 NOT NULL,
  "max_tokens" integer DEFAULT 0 NOT NULL,
  "max_cost" integer DEFAULT 0 NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_providers_name" ON "llm_providers" USING btree ("name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_submission_id" ON "llm_usage" USING btree ("submission_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_problem_id" ON "llm_usage" USING btree ("problem_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_user_id" ON "llm_usage" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_provider_id" ON "llm_usage" USING btree ("provider_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_created_at" ON "llm_usage" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_quotas_scope" ON "llm_quotas" USING btree ("scope_type", "scope_id", "window_type");
```

- [ ] **Step 3: 创建 `src/db/migrate.ts`**

```ts
import postgres from "postgres";
import { dirname, resolve } from "jsr:@std/path@^1";

/**
 * 执行 noj-llm-gateway 自己的 SQL 迁移。
 *
 * 使用独立的 llm_schema_migrations 表记录已应用文件，避免与 noj-core
 * 的 Drizzle 迁移记录互相干扰。基线迁移使用 IF NOT EXISTS，老库可安全执行。
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS llm_schema_migrations (
        id serial PRIMARY KEY,
        name text NOT NULL UNIQUE,
        applied_at text NOT NULL
      )
    `;

    const dir = resolve(
      dirname(new URL(import.meta.url).pathname),
      "../../drizzle",
    );
    const files: string[] = [];
    for (const entry of Deno.readDirSync(dir)) {
      if (entry.isFile && entry.name.endsWith(".sql")) files.push(entry.name);
    }
    files.sort();

    for (const file of files) {
      const applied = await sql`
        SELECT 1 FROM llm_schema_migrations WHERE name = ${file}
      `;
      if (applied.length > 0) continue;

      const content = await Deno.readTextFile(resolve(dir, file));
      await sql.unsafe(content);
      await sql`
        INSERT INTO llm_schema_migrations (name, applied_at)
        VALUES (${file}, ${new Date().toISOString()})
      `;
      console.log(`[llm-gateway] 已应用迁移: ${file}`);
    }
  } finally {
    await sql.end();
  }
}
```

- [ ] **Step 4: 创建 `src/db/migrate-cli.ts`**

```ts
import { loadConfig } from "../config.ts";
import { runMigrations } from "./migrate.ts";

const config = loadConfig();
await runMigrations(config.databaseUrl);
console.log("LLM gateway 迁移完成");
```

- [ ] **Step 5: 创建 `src/db/seed.ts`**

```ts
import type { Db } from "./db.ts";

interface DefaultQuota {
  id: string;
  scope_type: "user" | "problem" | "global";
  scope_id: string;
  window_type: "day" | "month";
  max_calls: number;
  max_tokens: number;
  max_cost: number;
}

const DEFAULTS: DefaultQuota[] = [
  {
    id: "llm-quota-global-day",
    scope_type: "global",
    scope_id: "",
    window_type: "day",
    max_calls: 10000,
    max_tokens: 1_000_000,
    max_cost: 1000,
  },
  {
    id: "llm-quota-global-month",
    scope_type: "global",
    scope_id: "",
    window_type: "month",
    max_calls: 100_000,
    max_tokens: 10_000_000,
    max_cost: 10_000,
  },
  {
    id: "llm-quota-user-day",
    scope_type: "user",
    scope_id: "",
    window_type: "day",
    max_calls: 1000,
    max_tokens: 100_000,
    max_cost: 100,
  },
  {
    id: "llm-quota-problem-day",
    scope_type: "problem",
    scope_id: "",
    window_type: "day",
    max_calls: 5000,
    max_tokens: 500_000,
    max_cost: 500,
  },
];

/** 幂等写入默认 LLM 配额；已有行不覆盖。 */
export async function seedDefaultQuotas(db: Db): Promise<void> {
  const now = new Date().toISOString();
  for (const q of DEFAULTS) {
    const existing = await db`
      SELECT id FROM llm_quotas
      WHERE scope_type = ${q.scope_type}
        AND scope_id = ${q.scope_id}
        AND window_type = ${q.window_type}
      LIMIT 1
    `;
    if (existing.length > 0) continue;
    await db`
      INSERT INTO llm_quotas (
        id, scope_type, scope_id, window_type,
        max_calls, max_tokens, max_cost, created_at, updated_at
      ) VALUES (
        ${q.id}, ${q.scope_type}, ${q.scope_id}, ${q.window_type},
        ${q.max_calls}, ${q.max_tokens}, ${q.max_cost}, ${now}, ${now}
      )
    `;
    console.log(`[llm-gateway] 已写入默认配额: ${q.scope_type}/${q.window_type}`);
  }
}
```

- [ ] **Step 6: 修改 `src/main.ts`**

```ts
import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";
import { runMigrations } from "./db/migrate.ts";
import { createDb } from "./db.ts";
import { seedDefaultQuotas } from "./db/seed.ts";

const config = loadConfig();

await runMigrations(config.databaseUrl);

const seedDb = createDb(config.databaseUrl);
await seedDefaultQuotas(seedDb);
await seedDb.end();

const app = createApp(config);

Deno.serve({ port: config.port }, app.fetch);
```

- [ ] **Step 7: 修改 `deno.json`**

在 `tasks` 中新增：

```json
"db:migrate": "deno run --env-file=.env -A src/db/migrate-cli.ts",
"db:generate": "deno -A npm:drizzle-kit generate --config=./drizzle.config.ts"
```

在 `imports` 中新增：

```json
"drizzle-orm": "npm:drizzle-orm@0.45.2",
"drizzle-orm/": "npm:/drizzle-orm@0.45.2/",
"drizzle-kit": "npm:drizzle-kit@0.31.10"
```

- [ ] **Step 8: 创建 `drizzle.config.ts`**

```ts
import { defineConfig } from "drizzle-kit";

const databaseUrl = Deno.env.get("DATABASE_URL");
if (!databaseUrl) {
  throw new Error("环境变量 DATABASE_URL 未设置");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
```

- [ ] **Step 9: 验证 gateway 迁移与 seed**

```bash
cd noj-llm-gateway
deno fmt
deno task check
deno task db:migrate
```

预期：`db:migrate` 输出“已应用迁移: 0000_baseline.sql”，重复执行不报错。

- [ ] **Step 10: 提交**

```bash
jj commit -m "feat(llm-gateway): 接管 LLM 表迁移与默认配额 seed"
```

---

### Task 3: noj-core 移除 LLM 表定义、外键与种子

**Files:**
- Modify: `noj-core/src/db/schema/submission.ts`
- Delete: `noj-core/src/db/schema/gateway.ts`
- Modify: `noj-core/src/db/schema/index.ts`
- Modify: `noj-core/src/db/schema-ddl.ts`
- Modify: `noj-core/src/domains/system/services/seed/seed-system.ts`
- Modify: `noj-core/scripts/noj.ts`
- Create: `noj-core/drizzle/XXXX_*.sql`（由 `db:generate` 生成后手工编辑）

**Interfaces:**
- Consumes: Task 1 的域 schema 文件。
- Produces: core 不再导出 `llmProviders` / `llmUsage` / `llmQuotas`；`submissions.llm_provider_config_id` 变为无 FK 的 text 列。

- [ ] **Step 1: 修改 `submission.ts` 移除 FK**

将：

```ts
llm_provider_config_id: text("llm_provider_config_id").references(
  () => llmProviders.id,
  { onDelete: "set null" },
),
```

改为：

```ts
llm_provider_config_id: text("llm_provider_config_id"),
```

并删除文件中的 `import { llmProviders } from "./gateway.ts";`。

- [ ] **Step 2: 删除 `gateway.ts` 并从 `index.ts` 移除导出**

删除 `noj-core/src/db/schema/gateway.ts`。

在 `noj-core/src/db/schema/index.ts` 中删除：

```ts
export * from "./gateway.ts";
```

- [ ] **Step 3: 修改 `schema-ddl.ts`**

删除以下三张表的 `CREATE TABLE IF NOT EXISTS` 块（原约 176-219 行）：

- `llm_providers`
- `llm_usage`
- `llm_quotas`

删除以下索引行（原约 643-649 行）：

```ts
"CREATE INDEX IF NOT EXISTS idx_llm_providers_name ON llm_providers (name)",
"CREATE INDEX IF NOT EXISTS idx_llm_usage_submission_id ON llm_usage (submission_id)",
"CREATE INDEX IF NOT EXISTS idx_llm_usage_problem_id ON llm_usage (problem_id)",
"CREATE INDEX IF NOT EXISTS idx_llm_usage_user_id ON llm_usage (user_id)",
"CREATE INDEX IF NOT EXISTS idx_llm_usage_provider_id ON llm_usage (provider_id)",
"CREATE INDEX IF NOT EXISTS idx_llm_usage_created_at ON llm_usage (created_at)",
"CREATE INDEX IF NOT EXISTS idx_llm_quotas_scope ON llm_quotas (scope_type, scope_id, window_type)",
```

将 `submissions` 建表语句中的：

```sql
llm_provider_config_id TEXT REFERENCES llm_providers(id) ON DELETE SET NULL,
```

改为：

```sql
llm_provider_config_id TEXT,
```

- [ ] **Step 4: 修改 `seed-system.ts` 删除 `seedLlmQuotas`**

删除文件顶部的 `llmQuotas` import，并删除整个 `seedLlmQuotas()` 函数（原约 163-247 行）。

- [ ] **Step 5: 修改 `scripts/noj.ts` 删除调用**

删除：

```ts
import { seedLlmQuotas } from "../src/domains/system/services/seed/seed-system.ts";
```

以及 `runInitSystem()` 中的：

```ts
console.log("初始化 LLM 默认配额...");
await seedLlmQuotas();
```

- [ ] **Step 6: 生成并手工编辑 core 迁移**

```bash
cd noj-core
deno task db:generate
```

会生成一个新的 `drizzle/XXXX_*.sql`。打开该文件，**删除其中三条 `DROP TABLE` 语句**（`llm_providers` / `llm_usage` / `llm_quotas`），只保留：

```sql
ALTER TABLE "submissions" DROP CONSTRAINT "submissions_llm_provider_config_id_llm_providers_id_fk";
```

以及可能存在的其他预期变更。不要修改 `_journal.json`。

- [ ] **Step 7: 验证 core 不再引用 LLM 表**

```bash
cd noj-core
deno fmt
deno task check:types
deno task check:domains
```

预期：`check:domains` 0 违规；`rg "llmProviders|llmUsage|llmQuotas" src` 只应命中历史迁移/快照或注释，不应命中业务代码。

- [ ] **Step 8: 运行 core 测试**

```bash
cd noj-core
deno task test:smoke
```

若本机有 PostgreSQL，再运行：

```bash
deno task test:parallel
```

- [ ] **Step 9: 提交**

```bash
jj commit -m "refactor(core): 移除 LLM 表定义与跨域外键，所有权移交 gateway"
```

---

### Task 4: 更新文档与配置

**Files:**
- Modify: `dev-docs/engineering/domain-boundaries.md`
- Modify: `noj-llm-gateway/README.md`
- Modify: `noj-llm-gateway/CLAUDE.md`
- Modify: `noj-llm-gateway/.env.example`（如无新增变量则仅确认）

**Interfaces:**
- Consumes: Task 2/3 的最终状态。
- Produces: 文档反映 LLM 表由 noj-llm-gateway 拥有。

- [ ] **Step 1: 更新 `domain-boundaries.md`**

将表所有权表格中的：

```markdown
| `llm_providers`、`llm_usage`、`llm_quotas` | gateway |
```

改为：

```markdown
| `llm_providers`、`llm_usage`、`llm_quotas` | noj-llm-gateway（同库 public schema，core 不直接读写） |
```

- [ ] **Step 2: 更新 `noj-llm-gateway/README.md`**

在“常用命令”中补充：

```markdown
deno task db:migrate   # 执行 LLM 表迁移（幂等）
```

在“职责”中补充一句：LLM 三表由本服务负责迁移与默认配额 seed。

- [ ] **Step 3: 更新 `noj-llm-gateway/CLAUDE.md`**

在“开发命令”中补充：

```markdown
deno task db:migrate   # 执行 LLM 表迁移（幂等）
```

- [ ] **Step 4: 确认 `.env.example`**

`noj-llm-gateway/.env.example` 无需新增必填变量；如已有 `DATABASE_URL` 则保持。

- [ ] **Step 5: 提交**

```bash
jj commit -m "docs(core): 更新 LLM 表所有权与 gateway 迁移说明"
```

---

### Task 5: 全量验证

**Files:**
- 无新增文件；仅运行验证命令。

**Interfaces:**
- Consumes: Task 1-4 全部变更。

- [ ] **Step 1: 运行 noj-core 全量检查**

```bash
cd noj-core
deno task check
deno task test:smoke
```

- [ ] **Step 2: 运行 noj-llm-gateway 全量检查**

```bash
cd noj-llm-gateway
deno task check
deno task test
```

- [ ] **Step 3: 运行仓库级 check-all**

```bash
deno run -A scripts/check-all.ts
```

> 若沙箱拒绝 npm 缓存写入，使用 `sandbox_permissions: danger-full-access` 重试一次。

- [ ] **Step 4: 运行 LLM 网关 E2E（如环境允许）**

```bash
cd noj-tests
deno task test -- e2e/32_llm_gateway.test.ts
```

- [ ] **Step 5: 确认 jj 状态与提交历史**

```bash
jj status
jj log --limit 8
```

预期：工作副本干净，包含 Task 1-4 的提交。

---

## Self-Review

- **Spec coverage:** 覆盖 spec 的 schema 拆分、gateway 迁移/seed、core 移除表/外键/种子、文档更新、验证。
- **Placeholder scan:** 所有步骤均给出具体文件、代码或操作；无 TBD。
- **Type consistency:** `runMigrations(databaseUrl: string)`、`seedDefaultQuotas(db: Db)` 在 Task 2 定义并在 Task 2/5 使用；`llm_provider_config_id` 在 Task 1 保留 FK、Task 3 移除，前后一致。
