# 中心化 Search Domain 后端核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 noj-core 中建立独立的 `search` domain，以统一索引表 `search_entries` 聚合题目、用户、社区帖子/评论、竞赛、提交、私信、公告，并提供 grouped/flat 搜索 API、事件消费者与 reindex CLI。

**Architecture:** 新建 `search` domain 作为 `search_entries` 唯一写者；源域通过 Redis MQ 事件通知索引更新；搜索 API 统一查 `search_entries` 并按行级权限过滤；`query` 域保留排行/统计，搜索代码迁出。

**Tech Stack:** Deno 2 + Hono + Drizzle ORM + PostgreSQL 16 (tsvector + pg_trgm) + Redis MQ + ioredis。

**Spec:** `dev-docs/superpowers/specs/2026-09-07-centralized-search-domain-design.md`

## Global Constraints

- 所有提交必须 GPG 签名（`commit.gpgsign=true`，密钥 `F2228B681060D92532F4528974E9300535E7C223`）。
- 项目使用 jj 作为本地版本控制；**不要使用 `git add` / `git commit`**，改用 `jj describe` / `jj new`。
- 提交信息格式：`<type>(<scope>): 中文描述`（type: feat/fix/docs/test/refactor；scope: core/ui/judge）。
- 项目语言：中文（提交、注释、文档）；代码标识符用英文。
- TypeScript 严格模式；错误处理统一走 `AppError` 继承体系。
- 数据库 schema 改动必须经过 Drizzle 迁移流程：先改 schema，再 `deno task db:generate`，生成后手工调整 SQL 中的 GENERATED 表达式（不手动改 `_journal.json`）。
- 测试必须通过 `deno task` 运行，优先 `deno task test:parallel`；不要直接手拼 `deno test`。
- 路由层不直接 SQL，统一走 service 层；service 层不感知 Hono Context。
- 搜索 API 继续使用 `searchRateLimit` 限流。
- 所有用户输入通过 Drizzle 参数化 SQL；`ILIKE` 必须经 `escapeLikePattern()` 转义并带 `ESCAPE '\'`。

---

### Task 1: 新增 `search_entries` 表 schema 与迁移

**Files:**
- Create: `noj-core/src/shared/db/schema/search.ts`
- Modify: `noj-core/src/shared/db/schema/index.ts`
- Generate: `noj-core/drizzle/0074_*.sql`（由 `deno task db:generate` 生成后手工调整）

**Interfaces:**
- Produces: Drizzle 表 `searchEntries`，供 index-writer 使用。

- [ ] **Step 1: 创建 schema 文件**

创建 `noj-core/src/shared/db/schema/search.ts`：

```ts
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tsvector } from "./common.ts";

/**
 * 统一搜索索引表。
 * 唯一写者是 search domain；源域通过事件通知更新。
 */
export const searchEntries = pgTable(
  "search_entries",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    entity_type: text("entity_type").notNull(),
    entity_id: text("entity_id").notNull(),
    title: text("title").notNull().default(""),
    body: text("body").notNull().default(""),
    /** tsvector 列，GENERATED 自动维护，ORM 不可写入 */
    searchVector: tsvector("search_vector"),
    metadata: jsonb("metadata").notNull().default({}),
    owner_id: text("owner_id"),
    participant_ids: text("participant_ids").array().notNull().default(sql`'{}'`),
    is_public: boolean("is_public").notNull().default(false),
    admin_only: boolean("admin_only").notNull().default(false),
    is_active: boolean("is_active").notNull().default(true),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    entityUnique: uniqueIndex("idx_search_entries_entity").on(
      table.entity_type,
      table.entity_id,
    ),
    searchVectorIdx: index("idx_search_entries_vector").using(
      "gin",
      table.searchVector,
    ),
    titleTrgmIdx: index("idx_search_entries_title_trgm").using(
      "gin",
      table.title.op("gin_trgm_ops"),
    ),
    bodyTrgmIdx: index("idx_search_entries_body_trgm").using(
      "gin",
      table.body.op("gin_trgm_ops"),
    ),
    ownerIdx: index("idx_search_entries_owner").on(table.owner_id),
    participantsIdx: index("idx_search_entries_participants").using(
      "gin",
      table.participant_ids,
    ),
    publicIdx: index("idx_search_entries_public").on(table.is_public),
    updatedIdx: index("idx_search_entries_updated").on(table.updated_at),
  }),
);
```

- [ ] **Step 2: 在 schema 入口导出**

修改 `noj-core/src/shared/db/schema/index.ts`，在末尾追加：

```ts
export * from "./search.ts";
```

- [ ] **Step 3: 生成迁移**

运行：

```bash
cd noj-core && deno task db:generate
```

预期：生成 `drizzle/0074_*.sql` 并自动更新 `_journal.json`。

- [ ] **Step 4: 手工调整生成的 SQL**

打开生成的 `drizzle/0074_*.sql`，把 `search_vector tsvector` 列改为 GENERATED 表达式：

```sql
search_vector tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(body, '')), 'B')
) STORED
```

并确认包含以下索引（若 Drizzle 未生成则手工补上）：

```sql
CREATE INDEX IF NOT EXISTS "idx_search_entries_title_trgm" ON "search_entries" USING gin ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_search_entries_body_trgm" ON "search_entries" USING gin ("body" gin_trgm_ops);
```

- [ ] **Step 5: 运行迁移验证**

```bash
cd noj-core && deno task db:migrate
```

预期：迁移成功，`search_entries` 表存在。

- [ ] **Step 6: 提交**

```bash
jj describe -m "feat(core): 新增 search_entries 统一搜索索引表"
jj new
```

---

### Task 2: 共享搜索事件类型与发布工具

**Files:**
- Create: `noj-core/src/shared/search-events.ts`

**Interfaces:**
- Produces: `SearchEntityType`、`SearchIndexAction`、`SearchIndexEvent`、`SEARCH_INDEX_QUEUE`、`publishSearchIndexEvent()`。

- [ ] **Step 1: 创建文件**

创建 `noj-core/src/shared/search-events.ts`：

```ts
import { getRedis } from "./mq/connection.ts";
import { logger } from "./base/logging.ts";

export type SearchEntityType =
  | "problem"
  | "user"
  | "community_post"
  | "community_comment"
  | "contest"
  | "submission"
  | "message"
  | "announcement";

export type SearchIndexAction = "upsert" | "delete";

export interface SearchIndexEvent {
  entityType: SearchEntityType;
  entityId: string;
  action: SearchIndexAction;
  occurredAt: string;
  requestId?: string;
}

export const SEARCH_INDEX_QUEUE = "noj:search:index";

/**
 * 发布搜索索引更新事件。
 * 源域在业务写事务成功提交后调用；发布失败只记录日志，不阻塞主流程。
 */
export async function publishSearchIndexEvent(
  entityType: SearchEntityType,
  entityId: string,
  action: SearchIndexAction,
  requestId?: string,
): Promise<void> {
  const event: SearchIndexEvent = {
    entityType,
    entityId,
    action,
    occurredAt: new Date().toISOString(),
    requestId,
  };
  try {
    const redis = getRedis();
    await redis.lpush(SEARCH_INDEX_QUEUE, JSON.stringify(event));
  } catch (err) {
    logger.error("发布搜索索引事件失败", {
      entityType,
      entityId,
      action,
      err,
    });
  }
}
```

- [ ] **Step 2: 提交**

```bash
jj describe -m "feat(core): 新增搜索索引事件发布工具"
jj new
```

---

### Task 3: search domain 类型与 index-writer

**Files:**
- Create: `noj-core/src/domains/search/types.ts`
- Create: `noj-core/src/domains/search/services/index-writer.ts`
- Test: `noj-core/src/domains/search/tests/services/index-writer.test.ts`

**Interfaces:**
- Produces: `SearchEntryInput`、`upsertSearchEntry()`、`deleteSearchEntry()`、`buildProblemEntry()`、`buildUserEntry()`、`buildCommunityPostEntry()`、`buildCommunityCommentEntry()`、`buildContestEntry()`、`buildSubmissionEntry()`、`buildMessageEntry()`、`buildAnnouncementEntry()`、`reindexAll()`。

- [ ] **Step 1: 创建 types.ts**

创建 `noj-core/src/domains/search/types.ts`：

```ts
import type { SearchEntityType } from "../../shared/search-events.ts";

export interface SearchEntryInput {
  entityType: SearchEntityType;
  entityId: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  ownerId?: string | null;
  participantIds?: string[];
  isPublic: boolean;
  adminOnly?: boolean;
  isActive?: boolean;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: 创建 index-writer.ts**

创建 `noj-core/src/domains/search/services/index-writer.ts`：

```ts
import { sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { searchEntries } from "../../../shared/db/schema.ts";
import type { SearchEntryInput } from "../types.ts";

export async function upsertSearchEntry(input: SearchEntryInput): Promise<void> {
  const db = getDb();
  await db
    .insert(searchEntries)
    .values({
      entity_type: input.entityType,
      entity_id: input.entityId,
      title: input.title,
      body: input.body,
      metadata: input.metadata,
      owner_id: input.ownerId ?? null,
      participant_ids: input.participantIds ?? [],
      is_public: input.isPublic,
      admin_only: input.adminOnly ?? false,
      is_active: input.isActive ?? true,
      created_at: input.createdAt,
      updated_at: input.updatedAt,
    })
    .onConflictDoUpdate({
      target: [searchEntries.entity_type, searchEntries.entity_id],
      set: {
        title: input.title,
        body: input.body,
        metadata: input.metadata,
        owner_id: input.ownerId ?? null,
        participant_ids: input.participantIds ?? [],
        is_public: input.isPublic,
        admin_only: input.adminOnly ?? false,
        is_active: input.isActive ?? true,
        updated_at: input.updatedAt,
      },
    });
}

export async function deleteSearchEntry(
  entityType: string,
  entityId: string,
): Promise<void> {
  const db = getDb();
  await db.delete(searchEntries).where(
    sql`${searchEntries.entity_type} = ${entityType} AND ${searchEntries.entity_id} = ${entityId}`,
  );
}

export async function buildProblemEntry(
  id: string,
): Promise<SearchEntryInput | null> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    title: string;
    description: string;
    difficulty: string;
    number: number;
    type: string;
    owner_id: string;
    visibility: string;
    created_at: string;
    updated_at: string;
    tags: string | null;
  }>(sql`
    SELECT p.id, p.title, p.description, p.difficulty, p.number, p.type,
           p.owner_id, p.visibility, p.created_at, p.updated_at,
           COALESCE((
             SELECT string_agg(t.name, ' ' ORDER BY t.name)
             FROM problem_tags pt JOIN tags t ON t.id = pt.tag_id
             WHERE pt.problem_id = p.id
           ), '') AS tags
    FROM problems p
    WHERE p.id = ${id}
  `);
  const row = rows[0];
  if (!row) return null;
  const displayId = `${row.type}${row.number}`;
  return {
    entityType: "problem",
    entityId: row.id,
    title: row.title,
    body: `${row.description} ${displayId} ${row.tags ?? ""}`.trim(),
    metadata: {
      display_id: displayId,
      difficulty: row.difficulty,
      type: row.type,
      number: row.number,
      tags: row.tags ? row.tags.split(" ") : [],
    },
    ownerId: row.owner_id,
    isPublic: row.visibility === "public",
    adminOnly: false,
    isActive: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function buildUserEntry(
  id: string,
): Promise<SearchEntryInput | null> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    username: string;
    email: string;
    bio: string;
    deleted_at: string | null;
    created_at: string;
    updated_at: string;
  }>(sql`
    SELECT id, username, email, bio, deleted_at, created_at, updated_at
    FROM users
    WHERE id = ${id}
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    entityType: "user",
    entityId: row.id,
    title: row.username,
    body: `${row.email} ${row.bio}`.trim(),
    metadata: { username: row.username, email: row.email },
    ownerId: null,
    isPublic: false,
    adminOnly: true,
    isActive: row.deleted_at === null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function buildCommunityPostEntry(
  id: string,
): Promise<SearchEntryInput | null> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    public_id: string;
    type: string;
    title: string | null;
    content: string;
    author_id: string;
    problem_id: string | null;
    status: string;
    created_at: string;
    updated_at: string;
    author_username: string;
    problem_type: string | null;
    problem_number: number | null;
    problem_title: string | null;
  }>(sql`
    SELECT p.id, p.public_id, p.type, p.title, p.content, p.author_id,
           p.problem_id, p.status, p.created_at, p.updated_at,
           u.username AS author_username,
           pr.type AS problem_type, pr.number AS problem_number,
           pr.title AS problem_title
    FROM community_posts p
    JOIN users u ON u.id = p.author_id
    LEFT JOIN problems pr ON pr.id = p.problem_id
    WHERE p.id = ${id}
  `);
  const row = rows[0];
  if (!row) return null;
  if (row.status !== "published" || (row.type !== "solution" && row.type !== "discussion")) {
    return null;
  }
  const problemText = row.problem_title
    ? `${row.problem_type}${row.problem_number} ${row.problem_title}`
    : "";
  return {
    entityType: "community_post",
    entityId: row.id,
    title: row.title ?? row.content.slice(0, 50),
    body: `${row.content} ${row.author_username} ${problemText}`.trim(),
    metadata: {
      public_id: row.public_id,
      post_type: row.type,
      author_id: row.author_id,
      author_username: row.author_username,
      problem_id: row.problem_id,
    },
    ownerId: row.author_id,
    isPublic: true,
    adminOnly: false,
    isActive: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function buildCommunityCommentEntry(
  id: string,
): Promise<SearchEntryInput | null> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    content: string;
    author_id: string;
    status: string;
    created_at: string;
    updated_at: string;
    author_username: string;
    post_title: string | null;
    post_status: string;
  }>(sql`
    SELECT c.id, c.content, c.author_id, c.status, c.created_at, c.updated_at,
           u.username AS author_username,
           p.title AS post_title, p.status AS post_status
    FROM community_comments c
    JOIN users u ON u.id = c.author_id
    JOIN community_posts p ON p.id = c.post_id
    WHERE c.id = ${id}
  `);
  const row = rows[0];
  if (!row) return null;
  if (row.status !== "published" || row.post_status !== "published") {
    return null;
  }
  return {
    entityType: "community_comment",
    entityId: row.id,
    title: row.content.slice(0, 50),
    body: `${row.content} ${row.author_username} ${row.post_title ?? ""}`.trim(),
    metadata: {
      author_id: row.author_id,
      author_username: row.author_username,
      post_title: row.post_title,
    },
    ownerId: row.author_id,
    isPublic: true,
    adminOnly: false,
    isActive: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function buildContestEntry(
  id: string,
): Promise<SearchEntryInput | null> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    public_id: string;
    title: string;
    description: string;
    kind: string;
    is_public: boolean;
    created_at: string;
    updated_at: string;
    participant_ids: string[];
  }>(sql`
    SELECT c.id, c.public_id, c.title, c.description, c.kind, c.is_public,
           c.created_at, c.updated_at,
           COALESCE((
             SELECT array_agg(user_id)
             FROM contest_participants cp
             WHERE cp.contest_id = c.id
           ), '{}') AS participant_ids
    FROM contests c
    WHERE c.id = ${id}
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    entityType: "contest",
    entityId: row.id,
    title: row.title,
    body: row.description,
    metadata: {
      public_id: row.public_id,
      kind: row.kind,
      is_public: row.is_public,
    },
    ownerId: null,
    participantIds: row.participant_ids,
    isPublic: row.is_public,
    adminOnly: false,
    isActive: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function buildSubmissionEntry(
  id: string,
): Promise<SearchEntryInput | null> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    public_id: string;
    user_id: string;
    problem_id: string;
    language: string;
    status: string;
    created_at: string;
    problem_title: string;
    problem_type: string;
    problem_number: number;
    submitter_username: string;
  }>(sql`
    SELECT s.id, s.public_id, s.user_id, s.problem_id, s.language, s.status,
           s.created_at,
           p.title AS problem_title, p.type AS problem_type, p.number AS problem_number,
           u.username AS submitter_username
    FROM submissions s
    JOIN problems p ON p.id = s.problem_id
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ${id}
  `);
  const row = rows[0];
  if (!row) return null;
  const displayId = `${row.problem_type}${row.problem_number}`;
  return {
    entityType: "submission",
    entityId: row.id,
    title: `${row.problem_title} - ${row.submitter_username}`,
    body: `${row.language} ${row.status} ${row.problem_title} ${displayId}`.trim(),
    metadata: {
      public_id: row.public_id,
      problem_id: row.problem_id,
      language: row.language,
      status: row.status,
      submitted_at: row.created_at,
    },
    ownerId: row.user_id,
    isPublic: false,
    adminOnly: false,
    isActive: true,
    createdAt: row.created_at,
    updatedAt: row.created_at,
  };
}

export async function buildMessageEntry(
  id: string,
): Promise<SearchEntryInput | null> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    conversation_id: string;
    sender_id: string;
    content: string;
    recalled_at: string | null;
    created_at: string;
    user1_id: string;
    user2_id: string;
    user1_username: string;
    user2_username: string;
  }>(sql`
    SELECT m.id, m.conversation_id, m.sender_id, m.content, m.recalled_at,
           m.created_at,
           c.user1_id, c.user2_id,
           u1.username AS user1_username, u2.username AS user2_username
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN users u1 ON u1.id = c.user1_id
    JOIN users u2 ON u2.id = c.user2_id
    WHERE m.id = ${id}
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    entityType: "message",
    entityId: row.id,
    title: `与 ${row.user1_username} / ${row.user2_username} 的私信`,
    body: `${row.content} ${row.user1_username} ${row.user2_username}`.trim(),
    metadata: {
      conversation_id: row.conversation_id,
      sender_id: row.sender_id,
      sent_at: row.created_at,
    },
    ownerId: null,
    participantIds: [row.user1_id, row.user2_id],
    isPublic: false,
    adminOnly: false,
    isActive: row.recalled_at === null,
    createdAt: row.created_at,
    updatedAt: row.created_at,
  };
}

export async function buildAnnouncementEntry(
  id: string,
): Promise<SearchEntryInput | null> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    public_id: string;
    title: string;
    content: string;
    is_active: boolean;
    created_at: string;
    updated_at: string;
  }>(sql`
    SELECT id, public_id, title, content, is_active, created_at, updated_at
    FROM announcements
    WHERE id = ${id}
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    entityType: "announcement",
    entityId: row.id,
    title: row.title,
    body: row.content,
    metadata: { public_id: row.public_id },
    ownerId: null,
    isPublic: row.is_active,
    adminOnly: false,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const BUILDERS: Record<string, (id: string) => Promise<SearchEntryInput | null>> = {
  problem: buildProblemEntry,
  user: buildUserEntry,
  community_post: buildCommunityPostEntry,
  community_comment: buildCommunityCommentEntry,
  contest: buildContestEntry,
  submission: buildSubmissionEntry,
  message: buildMessageEntry,
  announcement: buildAnnouncementEntry,
};

export async function processSearchIndexEvent(
  entityType: string,
  entityId: string,
  action: "upsert" | "delete",
): Promise<void> {
  const builder = BUILDERS[entityType];
  if (!builder) {
    throw new Error(`未知搜索实体类型: ${entityType}`);
  }
  if (action === "delete") {
    const current = await builder(entityId);
    if (current) {
      await upsertSearchEntry(current);
    } else {
      await deleteSearchEntry(entityType, entityId);
    }
    return;
  }
  const entry = await builder(entityId);
  if (entry) {
    await upsertSearchEntry(entry);
  } else {
    await deleteSearchEntry(entityType, entityId);
  }
}

export async function reindexAll(): Promise<Record<string, number>> {
  const db = getDb();
  await db.delete(searchEntries);
  const counts: Record<string, number> = {};
  for (const [entityType, builder] of Object.entries(BUILDERS)) {
    const table = entityTypeToTable(entityType);
    const rows = await db.execute<{ id: string }>(sql`SELECT id FROM ${table}`);
    const ids = "rows" in rows
      ? (rows as { rows: { id: string }[] }).rows
      : (rows as unknown as { id: string }[]);
    let count = 0;
    for (const row of ids) {
      const entry = await builder(row.id);
      if (entry) {
        await upsertSearchEntry(entry);
        count++;
      }
    }
    counts[entityType] = count;
  }
  return counts;
}

function entityTypeToTable(entityType: string): ReturnType<typeof sql> {
  const map: Record<string, ReturnType<typeof sql>> = {
    problem: sql`problems`,
    user: sql`users`,
    community_post: sql`community_posts`,
    community_comment: sql`community_comments`,
    contest: sql`contests`,
    submission: sql`submissions`,
    message: sql`messages`,
    announcement: sql`announcements`,
  };
  const table = map[entityType];
  if (!table) throw new Error(`未知搜索实体类型: ${entityType}`);
  return table;
}
```

- [ ] **Step 3: 写 index-writer 测试**

创建 `noj-core/src/domains/search/tests/services/index-writer.test.ts`：

```ts
import { assertEquals } from "jsr:@std/assert@^1";
import { resetDbForTest, getDb } from "../../../../shared/db/connection.ts";
import { problems, users } from "../../../../shared/db/schema.ts";
import {
  buildProblemEntry,
  buildUserEntry,
  deleteSearchEntry,
  processSearchIndexEvent,
  upsertSearchEntry,
} from "../../services/index-writer.ts";
import { searchEntries } from "../../../../shared/db/schema.ts";
import { sql } from "drizzle-orm";

await resetDbForTest();

Deno.test({
  name: "index-writer: upsert 后可按 entity 查到",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(problems).values({
      id: "p-search-1",
      title: "动态规划",
      description: "入门",
      difficulty: "medium",
      runtime_config: {
        evaluator: { image: "x", command: "x", time_limit_ms: 1000, memory_limit_mb: 128 },
        solution: { image: "x", call_timeout_ms: 1000, memory_limit_mb: 128 },
      },
      number: 1,
      type: "P",
      visibility: "public",
      created_at: now,
      updated_at: now,
    });
    const entry = await buildProblemEntry("p-search-1");
    assertEquals(entry !== null, true);
    await upsertSearchEntry(entry!);
    const rows = await db.select().from(searchEntries).where(
      sql`${searchEntries.entity_type} = 'problem' AND ${searchEntries.entity_id} = 'p-search-1'`,
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0]?.title, "动态规划");
  },
});

Deno.test({
  name: "index-writer: delete 后条目消失",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u-search-1",
      username: "alice",
      email: "alice@example.com",
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    const entry = await buildUserEntry("u-search-1");
    await upsertSearchEntry(entry!);
    await deleteSearchEntry("user", "u-search-1");
    const rows = await db.select().from(searchEntries).where(
      sql`${searchEntries.entity_type} = 'user' AND ${searchEntries.entity_id} = 'u-search-1'`,
    );
    assertEquals(rows.length, 0);
  },
});

Deno.test({
  name: "index-writer: processSearchIndexEvent delete 时源仍存在则转 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u-search-2",
      username: "bob",
      email: "bob@example.com",
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    await processSearchIndexEvent("user", "u-search-2", "delete");
    const rows = await db.select().from(searchEntries).where(
      sql`${searchEntries.entity_type} = 'user' AND ${searchEntries.entity_id} = 'u-search-2'`,
    );
    assertEquals(rows.length, 1);
  },
});
```

- [ ] **Step 4: 运行测试**

```bash
cd noj-core && deno task test -- src/domains/search/tests/services/index-writer.test.ts
```

预期：PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "feat(core): 实现 search index-writer 与实体构建器"
jj new
```

---

### Task 4: 权限过滤与搜索 service

**Files:**
- Create: `noj-core/src/domains/search/services/permission-filter.ts`
- Create: `noj-core/src/domains/search/services/search.ts`
- Test: `noj-core/src/domains/search/tests/services/search.test.ts`

**Interfaces:**
- Produces: `SearchPermissionContext`、`permissionWhere()`、`communityVisibilityWhere()`、`searchGrouped()`、`searchFlat()`。

- [ ] **Step 1: 创建 permission-filter.ts**

创建 `noj-core/src/domains/search/services/permission-filter.ts`：

```ts
import { sql } from "drizzle-orm";
import { searchEntries } from "../../../shared/db/schema.ts";

export interface SearchPermissionContext {
  userId?: string;
  isAdmin: boolean;
  guestReadEnabled: boolean;
}

export function permissionWhere(ctx: SearchPermissionContext) {
  const userId = ctx.userId ?? "";
  return sql`(
    ${searchEntries.is_public} = true
    OR ${searchEntries.owner_id} = ${userId}
    OR ${userId} = ANY(${searchEntries.participant_ids})
    OR ${ctx.isAdmin} = true
  ) AND (${searchEntries.admin_only} = false OR ${ctx.isAdmin} = true)`;
}

export function communityVisibilityWhere(ctx: SearchPermissionContext) {
  if (!ctx.userId && !ctx.guestReadEnabled) {
    return sql`${searchEntries.entity_type} NOT IN ('community_post', 'community_comment')`;
  }
  return sql`true`;
}
```

- [ ] **Step 2: 创建 search.ts**

创建 `noj-core/src/domains/search/services/search.ts`：

```ts
import { sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { searchEntries } from "../../../shared/db/schema.ts";
import type { SearchPermissionContext } from "./permission-filter.ts";
import { communityVisibilityWhere, permissionWhere } from "./permission-filter.ts";

function escapeLikePattern(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export interface SearchItem {
  entity_type: string;
  entity_id: string;
  title: string;
  highlight: string;
  rank: number;
  metadata: Record<string, unknown>;
}

export interface GroupedResult {
  groups: Record<string, { items: SearchItem[]; has_more: boolean }>;
  took_ms: number;
}

export interface FlatResult {
  items: SearchItem[];
  has_more: boolean;
  page: number;
  per_page: number;
  took_ms: number;
}

export async function searchGrouped(params: {
  q: string;
  types: string[];
  perType: number;
  ctx: SearchPermissionContext;
}): Promise<GroupedResult> {
  const db = getDb();
  const { q, types, perType, ctx } = params;
  const likeQ = `%${escapeLikePattern(q)}%`;
  const start = performance.now();
  const groups: GroupedResult["groups"] = {};

  for (const type of types) {
    const rows = await db.execute<{
      id: string;
      entity_type: string;
      entity_id: string;
      title: string;
      rank: number | null;
      highlight: string;
      metadata: Record<string, unknown>;
    }>(sql`
      SELECT id, entity_type, entity_id, title,
        ts_rank(search_vector, websearch_to_tsquery('simple', ${q})) AS rank,
        ts_headline('simple', title, websearch_to_tsquery('simple', ${q}),
          'StartSel=[[HIGHLIGHT]], StopSel=[[/HIGHLIGHT]], MaxWords=20, MinWords=5'
        ) AS highlight,
        metadata
      FROM search_entries
      WHERE entity_type = ${type}
        AND is_active = true
        AND (
          search_vector @@ websearch_to_tsquery('simple', ${q})
          OR title ILIKE ${likeQ} ESCAPE '\\'
          OR body ILIKE ${likeQ} ESCAPE '\\'
        )
        AND ${permissionWhere(ctx)}
        AND ${communityVisibilityWhere(ctx)}
      ORDER BY rank DESC NULLS LAST, updated_at DESC
      LIMIT ${perType + 1}
    `);
    const resultRows = "rows" in rows
      ? (rows as { rows: typeof rows[number][] }).rows
      : (rows as unknown as typeof rows[number][]);
    groups[type] = {
      items: resultRows.slice(0, perType).map((r) => ({
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        title: r.title,
        highlight: r.highlight,
        rank: r.rank ?? 0,
        metadata: r.metadata ?? {},
      })),
      has_more: resultRows.length > perType,
    };
  }

  return { groups, took_ms: Math.round(performance.now() - start) };
}

export async function searchFlat(params: {
  q: string;
  type?: string;
  page: number;
  perPage: number;
  ctx: SearchPermissionContext;
}): Promise<FlatResult> {
  const db = getDb();
  const { q, type, page, perPage, ctx } = params;
  const likeQ = `%${escapeLikePattern(q)}%`;
  const offset = (page - 1) * perPage;
  const start = performance.now();

  const rows = await db.execute<{
    id: string;
    entity_type: string;
    entity_id: string;
    title: string;
    rank: number | null;
    highlight: string;
    metadata: Record<string, unknown>;
  }>(sql`
    SELECT id, entity_type, entity_id, title,
      ts_rank(search_vector, websearch_to_tsquery('simple', ${q})) AS rank,
      ts_headline('simple', title, websearch_to_tsquery('simple', ${q}),
        'StartSel=[[HIGHLIGHT]], StopSel=[[/HIGHLIGHT]], MaxWords=20, MinWords=5'
      ) AS highlight,
      metadata
    FROM search_entries
    WHERE is_active = true
      AND (
        search_vector @@ websearch_to_tsquery('simple', ${q})
        OR title ILIKE ${likeQ} ESCAPE '\\'
        OR body ILIKE ${likeQ} ESCAPE '\\'
      )
      AND ${permissionWhere(ctx)}
      AND ${communityVisibilityWhere(ctx)}
      ${type ? sql`AND entity_type = ${type}` : sql``}
    ORDER BY rank DESC NULLS LAST, updated_at DESC
    LIMIT ${perPage + 1} OFFSET ${offset}
  `);
  const resultRows = "rows" in rows
    ? (rows as { rows: typeof rows[number][] }).rows
    : (rows as unknown as typeof rows[number][]);

  return {
    items: resultRows.slice(0, perPage).map((r) => ({
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      title: r.title,
      highlight: r.highlight,
      rank: r.rank ?? 0,
      metadata: r.metadata ?? {},
    })),
    has_more: resultRows.length > perPage,
    page,
    per_page: perPage,
    took_ms: Math.round(performance.now() - start),
  };
}
```

- [ ] **Step 3: 写搜索 service 测试**

创建 `noj-core/src/domains/search/tests/services/search.test.ts`：

```ts
import { assertEquals } from "jsr:@std/assert@^1";
import { resetDbForTest, getDb } from "../../../../shared/db/connection.ts";
import { problems, users } from "../../../../shared/db/schema.ts";
import { upsertSearchEntry } from "../../services/index-writer.ts";
import { buildProblemEntry, buildUserEntry } from "../../services/index-writer.ts";
import { searchFlat, searchGrouped } from "../../services/search.ts";

await resetDbForTest();

async function seed() {
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(problems).values({
    id: "p-search-1",
    title: "动态规划",
    description: "入门",
    difficulty: "medium",
    runtime_config: {
      evaluator: { image: "x", command: "x", time_limit_ms: 1000, memory_limit_mb: 128 },
      solution: { image: "x", call_timeout_ms: 1000, memory_limit_mb: 128 },
    },
    number: 1,
    type: "P",
    visibility: "public",
    created_at: now,
    updated_at: now,
  });
  await db.insert(users).values({
    id: "u-search-1",
    username: "alice",
    email: "alice@example.com",
    password_hash: "x",
    created_at: now,
    updated_at: now,
  });
  await upsertSearchEntry((await buildProblemEntry("p-search-1"))!);
  await upsertSearchEntry((await buildUserEntry("u-search-1"))!);
}

Deno.test({
  name: "search service: grouped 返回题目且匿名可见",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const result = await searchGrouped({
      q: "动态",
      types: ["problem", "user"],
      perType: 5,
      ctx: { userId: undefined, isAdmin: false, guestReadEnabled: true },
    });
    assertEquals(result.groups.problem.items.length, 1);
    assertEquals(result.groups.user.items.length, 0);
  },
});

Deno.test({
  name: "search service: flat 管理员可搜用户",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const result = await searchFlat({
      q: "alice",
      type: "user",
      page: 1,
      perPage: 20,
      ctx: { userId: "admin", isAdmin: true, guestReadEnabled: true },
    });
    assertEquals(result.items.length, 1);
    assertEquals(result.items[0]?.entity_type, "user");
  },
});
```

- [ ] **Step 4: 运行测试**

```bash
cd noj-core && deno task test -- src/domains/search/tests/services/search.test.ts
```

预期：PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "feat(core): 实现搜索权限过滤与 grouped/flat service"
jj new
```

---

### Task 5: 搜索路由与限流迁移

**Files:**
- Create: `noj-core/src/domains/search/routes/search.ts`
- Create: `noj-core/src/domains/search/routes/index.ts`
- Create: `noj-core/src/domains/search/middleware/search-rate-limit.ts`
- Create: `noj-core/src/domains/search/index.ts`
- Modify: `noj-core/src/app.ts`
- Modify: `noj-core/src/domains/query/routes/index.ts`
- Modify: `noj-core/src/domains/query/index.ts`
- Delete: `noj-core/src/domains/query/routes/search.ts`
- Delete: `noj-core/src/domains/query/services/search.ts`
- Delete: `noj-core/src/domains/query/middleware/search-rate-limit.ts`

**Interfaces:**
- Produces: `GET /api/v1/search` 新实现；`searchRateLimit` 从 query 域迁移到 search 域。

- [ ] **Step 1: 迁移限流中间件**

创建 `noj-core/src/domains/search/middleware/search-rate-limit.ts`，内容与现有 `query/middleware/search-rate-limit.ts` 相同，仅 import 路径改为 search 域相对路径：

```ts
import type { Context, MiddlewareHandler } from "hono";
import { getClientIp, settingBool, settingInt } from "../../system/index.ts";
import { RateLimitedError } from "../../../shared/base/errors.ts";
import {
  checkRateLimit,
  rateLimitHeaders,
} from "../../../shared/rate-limit/rate-limit.ts";
import { checkPermission } from "../../identity/index.ts";

export type SearchRateLimitDimension = "anon" | "authed";

export function searchRateLimit(
  dimension: SearchRateLimitDimension,
): MiddlewareHandler {
  return async (c: Context, next) => {
    if (!settingBool("rate_limit_search_enabled")) {
      return next();
    }
    if (await checkPermission(c, "admin:full_access")) {
      return next();
    }
    const windowSec = settingInt("rate_limit_search_window");
    const max = dimension === "anon"
      ? settingInt("rate_limit_search_max_anon")
      : settingInt("rate_limit_search_max_authed");
    let key: string;
    let identifier: string;
    if (dimension === "authed") {
      const userId = c.get("userId");
      if (!userId) return next();
      identifier = userId;
      key = `search:user:${identifier}`;
    } else {
      identifier = getClientIp(c);
      key = `search:ip:${identifier}`;
    }
    const cfg = { windowSec, max };
    const result = await checkRateLimit(key, cfg);
    if (!result.allowed) {
      throw new RateLimitedError(
        `搜索请求过于频繁，请稍后再试（${dimension === "anon" ? "IP" : "用户"}维度）`,
        rateLimitHeaders(cfg, result),
      );
    }
    const headers = rateLimitHeaders(cfg, result);
    for (const [k, v] of Object.entries(headers)) {
      c.header(k, v);
    }
    await next();
  };
}
```

- [ ] **Step 2: 创建搜索路由**

创建 `noj-core/src/domains/search/routes/search.ts`：

```ts
import { Hono } from "hono";
import { optionalAuthMiddleware } from "../../identity/index.ts";
import { searchRateLimit } from "../middleware/search-rate-limit.ts";
import { searchFlat, searchGrouped } from "../services/search.ts";
import { getCommunityConfig } from "../../community/index.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";
import { checkPermission } from "../../identity/index.ts";
import {
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "../../../shared/base/errors.ts";

type Env = {
  Variables: {
    userId?: string;
    userRole?: string;
    isAdmin?: boolean;
  };
};

const router = new Hono<Env>();

const ALL_TYPES = [
  "problem",
  "user",
  "community_post",
  "community_comment",
  "contest",
  "submission",
  "message",
  "announcement",
];

router.get(
  "/",
  optionalAuthMiddleware,
  searchRateLimit("anon"),
  async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const typesParam = c.req.query("types");
    const typeParam = c.req.query("type");
    const perTypeRaw = c.req.query("per_type");
    const perType = Math.min(
      Math.max(parseInt(perTypeRaw ?? "5", 10) || 5, 1),
      20,
    );
    const isAdmin = await checkPermission(c, "admin:full_access");
    const config = getCommunityConfig();
    const ctx = {
      userId: c.var.userId,
      isAdmin,
      guestReadEnabled: config.guest_read_enabled,
    };

    if (q.length < 2) {
      throw new ValidationError("搜索关键词至少需要 2 个字符");
    }
    if (q.length > 100) {
      throw new ValidationError("搜索关键词最多 100 个字符");
    }

    if (typesParam) {
      const types = typesParam.split(",").map((s) => s.trim()).filter(Boolean);
      for (const t of types) {
        if (!ALL_TYPES.includes(t)) {
          throw new ValidationError(`types 包含非法类型: ${t}`);
        }
      }
      const result = await searchGrouped({ q, types, perType, ctx });
      c.header("X-Search-Took-Ms", String(result.took_ms));
      return c.json({ data: { query: q, mode: "grouped", groups: result.groups, took_ms: result.took_ms } });
    }

    if (typeParam && !ALL_TYPES.includes(typeParam)) {
      throw new ValidationError("type 参数非法");
    }
    if (typeParam === "user" && !isAdmin) {
      if (!c.var.userId) throw new UnauthorizedError("请先登录");
      throw new ForbiddenError("仅管理员可搜索用户");
    }

    const { page, perPage } = parsePagination(c, {
      defaultPerPage: 20,
      maxPerPage: 50,
    });
    const result = await searchFlat({
      q,
      type: typeParam || undefined,
      page,
      perPage,
      ctx,
    });
    c.header("X-Search-Took-Ms", String(result.took_ms));
    return c.json({
      data: {
        query: q,
        mode: "flat",
        items: result.items,
        has_more: result.has_more,
        page: result.page,
        per_page: result.per_page,
        took_ms: result.took_ms,
      },
    });
  },
);

export default router;
```

- [ ] **Step 3: 创建 search 域路由入口与 index**

创建 `noj-core/src/domains/search/routes/index.ts`：

```ts
import { Hono } from "hono";
import search from "./search.ts";

export const searchRouter = new Hono();
searchRouter.route("/search", search);
```

创建 `noj-core/src/domains/search/index.ts`：

```ts
export * from "./services/index-writer.ts";
export * from "./services/search.ts";
export * from "./services/permission-filter.ts";
export * from "./middleware/search-rate-limit.ts";
export * from "./consumer/search-index-consumer.ts";
```

- [ ] **Step 4: 从 query 域移除旧搜索代码**

删除以下文件：

```bash
rm noj-core/src/domains/query/routes/search.ts
rm noj-core/src/domains/query/services/search.ts
rm noj-core/src/domains/query/middleware/search-rate-limit.ts
```

修改 `noj-core/src/domains/query/routes/index.ts`，移除 `search` 路由：

```ts
import { Hono } from "hono";
import rankings from "./rankings.ts";
import stats from "./stats.ts";
import statsSse from "./sse.ts";
import adminDashboard from "./admin-dashboard.ts";

export const queryRouter = new Hono();
queryRouter.route("/rankings", rankings);
queryRouter.route("/", stats);
queryRouter.route("/", statsSse);

export const queryAdminRouter = new Hono();
queryAdminRouter.route("/", adminDashboard);
```

修改 `noj-core/src/domains/query/index.ts`，移除搜索导出：

```ts
export * from "./services/rankings.ts";
export * from "./services/stats-cache.ts";
export * from "./services/dashboard.ts";
```

- [ ] **Step 5: 挂载 search 路由到 app.ts**

修改 `noj-core/src/app.ts`：

- import 区新增：

```ts
import { searchRouter } from "./domains/search/routes/index.ts";
```

- 在 `app.route("/api/v1", queryRouter);` 之后新增：

```ts
app.route("/api/v1", searchRouter);
```

- [ ] **Step 6: 运行现有搜索测试确认迁移**

```bash
cd noj-core && deno task test -- src/domains/query/tests/routes/search.test.ts
```

预期：该测试文件应被删除或迁移到 search 域；若仍存在会因找不到旧模块而失败，需同步删除旧测试文件：

```bash
rm noj-core/src/domains/query/tests/routes/search.test.ts
rm noj-core/src/domains/query/tests/services/search.test.ts
rm noj-core/src/domains/query/tests/middleware/search-rate-limit.test.ts
```

- [ ] **Step 7: 提交**

```bash
jj describe -m "refactor(core): 搜索路由/服务/限流迁移到 search domain"
jj new
```

---

### Task 6: 搜索事件消费者

**Files:**
- Create: `noj-core/src/domains/search/consumer/search-index-consumer.ts`
- Modify: `noj-core/src/main.ts`

**Interfaces:**
- Produces: `startSearchIndexConsumer()`、`shutdownSearchIndexConsumer()`。

- [ ] **Step 1: 创建消费者**

创建 `noj-core/src/domains/search/consumer/search-index-consumer.ts`：

```ts
import { createConsumer, requestConsumerShutdown } from "../../../shared/mq/base-consumer.ts";
import { SEARCH_INDEX_QUEUE, type SearchIndexEvent } from "../../../shared/search-events.ts";
import { processSearchIndexEvent } from "../services/index-writer.ts";

const aliveRef = { value: false };

export function startSearchIndexConsumer(): () => Promise<void> {
  return createConsumer({
    queueName: SEARCH_INDEX_QUEUE,
    logLabel: "搜索索引",
    aliveRef,
    handleMessage: async (data) => {
      const event = data as unknown as SearchIndexEvent;
      if (!event.entityType || !event.entityId || !event.action) {
        throw new Error("搜索索引事件缺少必要字段");
      }
      await processSearchIndexEvent(event.entityType, event.entityId, event.action);
    },
  });
}

export function shutdownSearchIndexConsumer(): void {
  requestConsumerShutdown();
}

export function isSearchIndexConsumerAlive(): boolean {
  return aliveRef.value;
}
```

- [ ] **Step 2: 在 main.ts 启动消费者**

修改 `noj-core/src/main.ts`：

- import 新增：

```ts
import { startSearchIndexConsumer } from "./domains/search/index.ts";
```

- 在 `void createReviewConsumer()();` 之后新增：

```ts
void startSearchIndexConsumer()();
```

- [ ] **Step 3: 提交**

```bash
jj describe -m "feat(core): 启动搜索索引事件消费者"
jj new
```

---

### Task 7: reindex CLI

**Files:**
- Modify: `noj-core/scripts/noj.ts`

**Interfaces:**
- Produces: `deno task search:reindex` 命令。

- [ ] **Step 1: 添加 search 子命令**

修改 `noj-core/scripts/noj.ts`：

- import 新增：

```ts
import { reindexAll } from "../src/domains/search/index.ts";
```

- 在 `problemsCmd` 定义后新增：

```ts
const searchCmd = new Command()
  .description("搜索索引操作")
  .command("reindex", "全量重建搜索索引")
  .action(async () => {
    console.log("开始全量重建搜索索引...");
    const counts = await reindexAll();
    console.log("重建完成", counts);
  });
```

- 在根命令 `.command("problems", problemsCmd)` 后新增：

```ts
.command("search", searchCmd)
```

- [ ] **Step 2: 在 deno.json 添加 task**

修改 `noj-core/deno.json` 的 `tasks`，新增：

```json
"search:reindex": "deno run -A scripts/noj.ts search reindex"
```

- [ ] **Step 3: 运行验证**

```bash
cd noj-core && deno task search:reindex
```

预期：输出各实体重建计数。

- [ ] **Step 4: 提交**

```bash
jj describe -m "feat(core): 新增 search:reindex 全量重建命令"
jj new
```

---

### Task 8: 路由集成测试与性能测试

**Files:**
- Create: `noj-core/src/domains/search/tests/routes/search.test.ts`
- Create: `noj-core/src/domains/search/tests/perf/search_bench.test.ts`

**Interfaces:**
- Verifies: 新搜索 API 的 grouped/flat、权限、限流。

- [ ] **Step 1: 写路由集成测试**

创建 `noj-core/src/domains/search/tests/routes/search.test.ts`：

```ts
import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { problems, users } from "../../../../shared/db/schema.ts";
import { jsonRequest } from "../../../../../tests/helper.ts";
import { connectRedis, getRedis } from "../../../../shared/mq/connection.ts";
import { upsertSearchEntry } from "../services/index-writer.ts";
import { buildProblemEntry, buildUserEntry } from "../services/index-writer.ts";

try {
  await connectRedis();
} catch (e) {
  if (!String(e).includes("already connecting/connected")) {
    console.warn("[setup] Redis 连接失败:", e);
  }
}

await resetDbForTest();

async function seed() {
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(problems).values({
    id: "p-search-route-1",
    title: "动态规划",
    description: "入门",
    difficulty: "medium",
    runtime_config: {
      evaluator: { image: "x", command: "x", time_limit_ms: 1000, memory_limit_mb: 128 },
      solution: { image: "x", call_timeout_ms: 1000, memory_limit_mb: 128 },
    },
    number: 1,
    type: "P",
    visibility: "public",
    created_at: now,
    updated_at: now,
  });
  await db.insert(users).values({
    id: "u-search-route-1",
    username: "alice_route",
    email: "alice-route@example.com",
    password_hash: "x",
    created_at: now,
    updated_at: now,
  });
  await upsertSearchEntry((await buildProblemEntry("p-search-route-1"))!);
  await upsertSearchEntry((await buildUserEntry("u-search-route-1"))!);
}

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasEnv;

Deno.test({
  name: "search route: grouped 模式返回题目",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const app = createApp();
    const res = await jsonRequest(
      app,
      "/api/v1/search?q=动态&types=problem,user&per_type=5",
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.mode, "grouped");
    assertEquals(body.data.groups.problem.items.length, 1);
  },
});

Deno.test({
  name: "search route: flat 模式管理员可搜用户",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const app = createApp();
    const res = await jsonRequest(
      app,
      "/api/v1/search?q=alice&type=user",
      { token: await createAdminToken() },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.items.length, 1);
  },
});

Deno.test({
  name: "search route: 匿名搜用户返回 401",
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
    const testIp = "127.0.0.1";
    const rateLimitKey = `ratelimit:search:ip:${testIp}`;
    await resetDbForTest();
    await seed();
    const redis = getRedis();
    await redis.del(rateLimitKey);
    try {
      const app = createApp();
      await jsonRequest(app, "/api/v1/search?q=test", { ip: testIp });
      await jsonRequest(app, "/api/v1/search?q=test", { ip: testIp });
      const res = await jsonRequest(app, "/api/v1/search?q=test", { ip: testIp });
      assertEquals(res.status, 429);
      assertExists(res.headers.get("retry-after"));
    } finally {
      await redis.del(rateLimitKey);
      Deno.env.delete("RATE_LIMIT_ENABLED");
      Deno.env.delete("RATE_LIMIT_SEARCH_ENABLED");
      Deno.env.delete("RATE_LIMIT_SEARCH_WINDOW");
      Deno.env.delete("RATE_LIMIT_SEARCH_MAX_ANON");
    }
  },
});

async function createAdminToken(): Promise<string> {
  const { createUserToken } = await import("../../../../../tests/helper.ts");
  return createUserToken({ role: "admin" });
}
```

- [ ] **Step 2: 写性能测试**

创建 `noj-core/src/domains/search/tests/perf/search_bench.test.ts`：

```ts
import { assert } from "jsr:@std/assert@^1";
import { resetDbForTest, getDb } from "../../../../shared/db/connection.ts";
import { problems } from "../../../../shared/db/schema.ts";
import { reindexAll } from "../../services/index-writer.ts";
import { searchFlat } from "../../services/search.ts";

await resetDbForTest();

Deno.test({
  name: "search perf: 10 万题重建后搜索 < 500ms",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    const BATCH = 1000;
    for (let i = 0; i < 100; i++) {
      const batch = Array.from({ length: BATCH }, (_, j) => ({
        id: `perf-p-${i}-${j}`,
        title: `题目 ${i * BATCH + j}：测试数据`,
        description: "",
        difficulty: "medium",
        runtime_config: {
          evaluator: { image: "x", command: "x", time_limit_ms: 1000, memory_limit_mb: 128 },
          solution: { image: "x", call_timeout_ms: 1000, memory_limit_mb: 128 },
        },
        number: i * BATCH + j + 1,
        type: "P" as const,
        visibility: "public",
        created_at: now,
        updated_at: now,
      }));
      await db.insert(problems).values(batch);
    }
    await reindexAll();
    const start = performance.now();
    const result = await searchFlat({
      q: "测试",
      page: 1,
      perPage: 20,
      ctx: { userId: undefined, isAdmin: false, guestReadEnabled: true },
    });
    const elapsed = performance.now() - start;
    console.log(`搜索耗时 ${elapsed.toFixed(0)}ms，命中 ${result.items.length}`);
    assert(elapsed < 500, `搜索 ${elapsed}ms 超 500ms 阈值`);
  },
});
```

- [ ] **Step 3: 运行测试**

```bash
cd noj-core && deno task test -- src/domains/search/tests/routes/search.test.ts
cd noj-core && deno task test -- src/domains/search/tests/perf/search_bench.test.ts
```

预期：PASS。

- [ ] **Step 4: 提交**

```bash
jj describe -m "test(core): 新增 search 路由集成与性能测试"
jj new
```

---

## Self-Review

- **Spec coverage:** 统一索引表（Task 1）、事件协议（Task 2/6）、index-writer（Task 3）、权限过滤（Task 4）、搜索 API（Task 5）、reindex（Task 7）、测试（Task 8）均已覆盖。
- **Placeholder scan:** 无 TBD/TODO；所有代码块为实际内容。
- **Type consistency:** `SearchEntryInput`、`processSearchIndexEvent`、`searchGrouped`/`searchFlat` 在后续任务中签名一致。
