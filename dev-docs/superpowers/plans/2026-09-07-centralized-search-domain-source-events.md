# 中心化 Search Domain 源域事件接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 catalog / identity / community / contest / submission / messaging / system 七个源域在业务写操作成功后发布搜索索引事件，驱动 search domain 更新 `search_entries`。

**Architecture:** 源域不直接写 `search_entries`，只在写事务成功后调用 `publishSearchIndexEvent(entityType, entityId, action)`；search domain 消费者负责读取源数据并更新索引。

**Tech Stack:** Deno 2 + Redis MQ + ioredis。

**Spec:** `dev-docs/superpowers/specs/2026-09-07-centralized-search-domain-design.md`
**Depends on:** `dev-docs/superpowers/plans/2026-09-07-centralized-search-domain-backend.md`（提供 `publishSearchIndexEvent`）

## Global Constraints

- 所有提交必须 GPG 签名。
- 项目使用 jj；不要使用 `git add` / `git commit`。
- 提交信息格式：`<type>(<scope>): 中文描述`。
- 事件发布失败不阻塞主流程（`publishSearchIndexEvent` 内部已 catch）。
- 事件只含 `{ entityType, entityId, action }`，不携带搜索正文。
- 测试通过 `deno task` 运行。

---

### Task 0: 搜索事件测试辅助

**Files:**
- Create: `noj-core/tests/helper/search-events.ts`

**Interfaces:**
- Produces: `assertSearchEventPublished(entityType, entityId, action)`。

- [ ] **Step 1: 创建测试辅助**

创建 `noj-core/tests/helper/search-events.ts`：

```ts
import { assertEquals } from "jsr:@std/assert@^1";
import { getRedis } from "../../src/shared/mq/connection.ts";
import { SEARCH_INDEX_QUEUE } from "../../src/shared/search-events.ts";

export async function assertSearchEventPublished(
  entityType: string,
  entityId: string,
  action: "upsert" | "delete",
): Promise<void> {
  const redis = getRedis();
  const raw = await redis.lrange(SEARCH_INDEX_QUEUE, 0, -1);
  const found = raw.some((item) => {
    try {
      const parsed = JSON.parse(item) as {
        entityType?: string;
        entityId?: string;
        action?: string;
      };
      return parsed.entityType === entityType &&
        parsed.entityId === entityId &&
        parsed.action === action;
    } catch {
      return false;
    }
  });
  assertEquals(found, true, `未找到搜索索引事件 ${entityType}:${entityId}:${action}`);
}
```

- [ ] **Step 2: 提交**

```bash
jj describe -m "test(core): 新增搜索索引事件断言辅助"
jj new
```

---

### Task 1: catalog 域事件接入

**Files:**
- Modify: `noj-core/src/domains/catalog/services/problems/problems-crud.ts`
- Modify: `noj-core/src/domains/catalog/services/tags.ts`
- Test: `noj-core/src/domains/catalog/tests/services/search-events.test.ts`

**Interfaces:**
- Consumes: `publishSearchIndexEvent` from `../../../shared/search-events.ts`（按实际相对路径调整）。
- Produces: 题目/标签变更后发布 `problem` 事件。

- [ ] **Step 1: 在 problems-crud.ts 接入**

在 `createProblem` 成功返回前插入：

```ts
await publishSearchIndexEvent("problem", created.id, "upsert");
```

在 `updateProblem` 成功返回前插入：

```ts
await publishSearchIndexEvent("problem", updated.id, "upsert");
```

在 `deleteProblem` 删除成功后插入：

```ts
await publishSearchIndexEvent("problem", id, "delete");
```

文件顶部新增 import：

```ts
import { publishSearchIndexEvent } from "../../../shared/search-events.ts";
```

- [ ] **Step 2: 在 tags.ts 接入**

标签变更会影响题目搜索（题目 body 含标签名），因此标签增删改后对关联题目发 `upsert`。在 `createTag` / `updateTag` / `deleteTag` 成功后，查询关联题目并逐个发布：

```ts
const rows = await db.execute<{ problem_id: string }>(sql`
  SELECT problem_id FROM problem_tags WHERE tag_id = ${tagId}
`);
for (const row of rows) {
  await publishSearchIndexEvent("problem", row.problem_id, "upsert");
}
```

- [ ] **Step 3: 写测试**

创建 `noj-core/src/domains/catalog/tests/services/search-events.test.ts`：

```ts
import { assertEquals } from "jsr:@std/assert@^1";
import { resetDbForTest, getDb } from "../../../../shared/db/connection.ts";
import { problems } from "../../../../shared/db/schema.ts";
import { createProblem, deleteProblem } from "../../services/problems/problems-crud.ts";
import { assertSearchEventPublished } from "../../../../../tests/helper/search-events.ts";
import { connectRedis } from "../../../../shared/mq/connection.ts";

try {
  await connectRedis();
} catch (e) {
  if (!String(e).includes("already connecting/connected")) {
    console.warn("[setup] Redis 连接失败:", e);
  }
}

await resetDbForTest();

Deno.test({
  name: "catalog search event: 创建题目发布 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const created = await createProblem({
      title: "事件测试题",
      description: "desc",
      difficulty: "easy",
      type: "P",
      ownerId: "0",
      runtimeConfig: {
        evaluator: { image: "x", command: "x", time_limit_ms: 1000, memory_limit_mb: 128 },
        solution: { image: "x", call_timeout_ms: 1000, memory_limit_mb: 128 },
      },
    });
    await assertSearchEventPublished("problem", created.id, "upsert");
  },
});
```

- [ ] **Step 4: 运行测试**

```bash
cd noj-core && deno task test -- src/domains/catalog/tests/services/search-events.test.ts
```

预期：PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "feat(core): catalog 域发布搜索索引事件"
jj new
```

---

### Task 2: identity 域事件接入

**Files:**
- Modify: `noj-core/src/domains/identity/services/users/users-profile-edit.ts`
- Modify: `noj-core/src/domains/identity/services/users/users-avatar.ts`
- Modify: `noj-core/src/domains/identity/services/account-deletion.ts`
- Test: `noj-core/src/domains/identity/tests/services/search-events.test.ts`

**Interfaces:**
- Produces: 用户资料/头像/注销后发布 `user` 事件。

- [ ] **Step 1: 在 users-profile-edit.ts 接入**

在 `updateUserProfile` 成功返回前插入：

```ts
await publishSearchIndexEvent("user", userId, "upsert");
```

- [ ] **Step 2: 在 users-avatar.ts 接入**

在 `updateUserAvatar` 成功返回前插入：

```ts
await publishSearchIndexEvent("user", userId, "upsert");
```

- [ ] **Step 3: 在 account-deletion.ts 接入**

在 `deleteOwnAccount` 软删除成功后插入：

```ts
await publishSearchIndexEvent("user", userId, "delete");
```

- [ ] **Step 4: 写测试**

创建 `noj-core/src/domains/identity/tests/services/search-events.test.ts`：

```ts
import { resetDbForTest, getDb } from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";
import { updateUserProfile } from "../../services/users/users-profile-edit.ts";
import { assertSearchEventPublished } from "../../../../../tests/helper/search-events.ts";
import { connectRedis } from "../../../../shared/mq/connection.ts";

try {
  await connectRedis();
} catch (e) {
  if (!String(e).includes("already connecting/connected")) {
    console.warn("[setup] Redis 连接失败:", e);
  }
}

await resetDbForTest();

Deno.test({
  name: "identity search event: 更新资料发布 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u-event-1",
      username: "event_user",
      email: "event@example.com",
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    await updateUserProfile("u-event-1", { bio: "新简介" });
    await assertSearchEventPublished("user", "u-event-1", "upsert");
  },
});
```

- [ ] **Step 5: 运行测试**

```bash
cd noj-core && deno task test -- src/domains/identity/tests/services/search-events.test.ts
```

预期：PASS。

- [ ] **Step 6: 提交**

```bash
jj describe -m "feat(core): identity 域发布搜索索引事件"
jj new
```

---

### Task 3: community 域事件接入

**Files:**
- Modify: `noj-core/src/domains/community/services/community/community-post-crud.ts`
- Modify: `noj-core/src/domains/community/services/community/community-post-moderation.ts`
- Modify: `noj-core/src/domains/community/services/community/community-comments.ts`
- Test: `noj-core/src/domains/community/tests/services/search-events.test.ts`

**Interfaces:**
- Produces: 帖子/评论增删改与状态变化后发布 `community_post` / `community_comment` 事件。

- [ ] **Step 1: 在 community-post-crud.ts 接入**

- `createPost` 成功后：`await publishSearchIndexEvent("community_post", created.id, "upsert");`
- `updatePost` 成功后：`await publishSearchIndexEvent("community_post", updated.id, "upsert");`
- 若存在 `deletePost` 函数，删除成功后：`await publishSearchIndexEvent("community_post", id, "delete");`

- [ ] **Step 2: 在 community-post-moderation.ts 接入**

在 `changePostStatus` 成功后：

```ts
await publishSearchIndexEvent("community_post", postId, "upsert");
```

- [ ] **Step 3: 在 community-comments.ts 接入**

- `createComment` 成功后：`await publishSearchIndexEvent("community_comment", created.id, "upsert");`
- `updateComment` 成功后：`await publishSearchIndexEvent("community_comment", updated.id, "upsert");`
- `deleteComment` 成功后：`await publishSearchIndexEvent("community_comment", id, "delete");`
- `changeCommentStatus` 成功后：`await publishSearchIndexEvent("community_comment", commentId, "upsert");`

- [ ] **Step 4: 写测试**

创建 `noj-core/src/domains/community/tests/services/search-events.test.ts`：

```ts
import { resetDbForTest, getDb } from "../../../../shared/db/connection.ts";
import { communityBoards, communityPosts, users } from "../../../../shared/db/schema.ts";
import { createPost } from "../../services/community/community-post-crud.ts";
import { assertSearchEventPublished } from "../../../../../tests/helper/search-events.ts";
import { connectRedis } from "../../../../shared/mq/connection.ts";

try {
  await connectRedis();
} catch (e) {
  if (!String(e).includes("already connecting/connected")) {
    console.warn("[setup] Redis 连接失败:", e);
  }
}

await resetDbForTest();

Deno.test({
  name: "community search event: 创建帖子发布 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u-community-event",
      username: "community_event",
      email: "community-event@example.com",
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    const board = await createBoard({ slug: "event-board", name: "事件板块" });
    const post = await createPost("u-community-event", {
      type: "discussion",
      board_id: board.id,
      title: "事件帖子",
      content: "内容",
    });
    await assertSearchEventPublished("community_post", post.id, "upsert");
  },
});
```

- [ ] **Step 5: 运行测试**

```bash
cd noj-core && deno task test -- src/domains/community/tests/services/search-events.test.ts
```

预期：PASS。

- [ ] **Step 6: 提交**

```bash
jj describe -m "feat(core): community 域发布搜索索引事件"
jj new
```

---

### Task 4: contest 域事件接入

**Files:**
- Modify: `noj-core/src/domains/contest/services/contests.ts`
- Test: `noj-core/src/domains/contest/tests/services/search-events.test.ts`

**Interfaces:**
- Produces: 竞赛增删改与参与者变化后发布 `contest` 事件。

- [ ] **Step 1: 在 contests.ts 接入**

- `createContest` 成功后：`await publishSearchIndexEvent("contest", created.id, "upsert");`
- `updateContest` 成功后：`await publishSearchIndexEvent("contest", updated.id, "upsert");`
- `deleteContest` 成功后：`await publishSearchIndexEvent("contest", id, "delete");`
- `registerForContest` / `addParticipants` / `removeParticipant` 成功后：`await publishSearchIndexEvent("contest", contestId, "upsert");`

- [ ] **Step 2: 写测试**

创建 `noj-core/src/domains/contest/tests/services/search-events.test.ts`：

```ts
import { resetDbForTest } from "../../../../shared/db/connection.ts";
import { createContest } from "../../services/contests.ts";
import { assertSearchEventPublished } from "../../../../../tests/helper/search-events.ts";
import { connectRedis } from "../../../../shared/mq/connection.ts";

try {
  await connectRedis();
} catch (e) {
  if (!String(e).includes("already connecting/connected")) {
    console.warn("[setup] Redis 连接失败:", e);
  }
}

await resetDbForTest();

Deno.test({
  name: "contest search event: 创建竞赛发布 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const contest = await createContest({
      title: "事件竞赛",
      description: "desc",
      startTime: "2026-01-01T00:00:00.000Z",
      endTime: "2026-01-02T00:00:00.000Z",
      type: "kaggle",
      kind: "public",
      createdBy: "0",
    });
    await assertSearchEventPublished("contest", contest.id, "upsert");
  },
});
```

- [ ] **Step 3: 运行测试**

```bash
cd noj-core && deno task test -- src/domains/contest/tests/services/search-events.test.ts
```

预期：PASS。

- [ ] **Step 4: 提交**

```bash
jj describe -m "feat(core): contest 域发布搜索索引事件"
jj new
```

---

### Task 5: submission 域事件接入

**Files:**
- Modify: `noj-core/src/domains/submission/services/submissions/submissions-crud.ts`
- Modify: `noj-core/src/domains/submission/services/submissions/submissions-result.ts`
- Test: `noj-core/src/domains/submission/tests/services/search-events.test.ts`

**Interfaces:**
- Produces: 提交创建/状态变化/删除后发布 `submission` 事件。

- [ ] **Step 1: 在 submissions-crud.ts 接入**

- `createSubmission` 成功后：`await publishSearchIndexEvent("submission", created.id, "upsert");`
- `deleteSubmission` 成功后：`await publishSearchIndexEvent("submission", id, "delete");`

- [ ] **Step 2: 在 submissions-result.ts 接入**

在 `updateSubmissionStatus` 成功后：

```ts
await publishSearchIndexEvent("submission", submissionId, "upsert");
```

- [ ] **Step 3: 写测试**

创建 `noj-core/src/domains/submission/tests/services/search-events.test.ts`：

```ts
import { resetDbForTest, getDb } from "../../../../shared/db/connection.ts";
import { problems, users } from "../../../../shared/db/schema.ts";
import { createSubmission } from "../../services/submissions/submissions-crud.ts";
import { assertSearchEventPublished } from "../../../../../tests/helper/search-events.ts";
import { connectRedis } from "../../../../shared/mq/connection.ts";

try {
  await connectRedis();
} catch (e) {
  if (!String(e).includes("already connecting/connected")) {
    console.warn("[setup] Redis 连接失败:", e);
  }
}

await resetDbForTest();

Deno.test({
  name: "submission search event: 创建提交发布 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u-sub-event",
      username: "sub_event",
      email: "sub-event@example.com",
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problems).values({
      id: "p-sub-event",
      title: "提交事件题",
      description: "",
      difficulty: "easy",
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
    const submission = await createSubmission({
      userId: "u-sub-event",
      problemId: "p-sub-event",
      language: "python",
      code: "print(1)",
    });
    await assertSearchEventPublished("submission", submission.id, "upsert");
  },
});
```

- [ ] **Step 4: 运行测试**

```bash
cd noj-core && deno task test -- src/domains/submission/tests/services/search-events.test.ts
```

预期：PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "feat(core): submission 域发布搜索索引事件"
jj new
```

---

### Task 6: messaging 域事件接入

**Files:**
- Modify: `noj-core/src/domains/messaging/services/messages.ts`
- Test: `noj-core/src/domains/messaging/tests/services/search-events.test.ts`

**Interfaces:**
- Produces: 消息发送/编辑/删除/撤回后发布 `message` 事件。

- [ ] **Step 1: 在 messages.ts 接入**

- `sendMessage` 成功后：`await publishSearchIndexEvent("message", created.id, "upsert");`
- `editMessage` 成功后：`await publishSearchIndexEvent("message", messageId, "upsert");`
- `deleteMessage` 成功后：`await publishSearchIndexEvent("message", messageId, "delete");`
- `recallMessage` 成功后：`await publishSearchIndexEvent("message", messageId, "upsert");`

- [ ] **Step 2: 写测试**

创建 `noj-core/src/domains/messaging/tests/services/search-events.test.ts`：

```ts
import { resetDbForTest, getDb } from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";
import { sendMessage } from "../../services/messages.ts";
import { assertSearchEventPublished } from "../../../../../tests/helper/search-events.ts";
import { connectRedis } from "../../../../shared/mq/connection.ts";

try {
  await connectRedis();
} catch (e) {
  if (!String(e).includes("already connecting/connected")) {
    console.warn("[setup] Redis 连接失败:", e);
  }
}

await resetDbForTest();

Deno.test({
  name: "messaging search event: 发送消息发布 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values([
      { id: "u-msg-1", username: "msg1", email: "msg1@example.com", password_hash: "x", created_at: now, updated_at: now },
      { id: "u-msg-2", username: "msg2", email: "msg2@example.com", password_hash: "x", created_at: now, updated_at: now },
    ]);
    const message = await sendMessage("u-msg-1", "u-msg-2", "你好");
    await assertSearchEventPublished("message", message.id, "upsert");
  },
});
```

- [ ] **Step 3: 运行测试**

```bash
cd noj-core && deno task test -- src/domains/messaging/tests/services/search-events.test.ts
```

预期：PASS。

- [ ] **Step 4: 提交**

```bash
jj describe -m "feat(core): messaging 域发布搜索索引事件"
jj new
```

---

### Task 7: system 域事件接入

**Files:**
- Modify: `noj-core/src/domains/system/services/announcements.ts`
- Test: `noj-core/src/domains/system/tests/services/search-events.test.ts`

**Interfaces:**
- Produces: 公告增删改后发布 `announcement` 事件。

- [ ] **Step 1: 在 announcements.ts 接入**

- `createAnnouncement` 成功后：`await publishSearchIndexEvent("announcement", created.id, "upsert");`
- `updateAnnouncement` 成功后：`await publishSearchIndexEvent("announcement", updated.id, "upsert");`
- `deleteAnnouncement` 成功后：`await publishSearchIndexEvent("announcement", id, "delete");`

- [ ] **Step 2: 写测试**

创建 `noj-core/src/domains/system/tests/services/search-events.test.ts`：

```ts
import { resetDbForTest } from "../../../../shared/db/connection.ts";
import { createAnnouncement } from "../../services/announcements.ts";
import { assertSearchEventPublished } from "../../../../../tests/helper/search-events.ts";
import { connectRedis } from "../../../../shared/mq/connection.ts";

try {
  await connectRedis();
} catch (e) {
  if (!String(e).includes("already connecting/connected")) {
    console.warn("[setup] Redis 连接失败:", e);
  }
}

await resetDbForTest();

Deno.test({
  name: "system search event: 创建公告发布 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const announcement = await createAnnouncement({
      title: "事件公告",
      content: "内容",
      createdBy: "0",
    });
    await assertSearchEventPublished("announcement", announcement.id, "upsert");
  },
});
```

- [ ] **Step 3: 运行测试**

```bash
cd noj-core && deno task test -- src/domains/system/tests/services/search-events.test.ts
```

预期：PASS。

- [ ] **Step 4: 提交**

```bash
jj describe -m "feat(core): system 域发布搜索索引事件"
jj new
```

---

## Self-Review

- **Spec coverage:** 七个源域的事件发布均已覆盖；事件格式与 Plan A 一致。
- **Placeholder scan:** 无 TBD/TODO；每个任务都有具体插入位置和测试。
- **Type consistency:** 统一使用 `publishSearchIndexEvent(entityType, entityId, action)`，实体类型与 Plan A 的 `SearchEntityType` 一致。
