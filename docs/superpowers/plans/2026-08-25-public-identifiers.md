# 前端可读公开标识（Public Identifier）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为竞赛、训练、提交、社区帖子、公告增加不可变 `public_id`，并让 noj-ui（含 admin）全面改用公开标识，API 保留 UUID 兼容。

**Architecture:** 后端在 5 张业务表新增 `public_id` 唯一列，创建时生成 `前缀 + 8 位随机短码`；新增统一 `public-id.ts` 解析工具，路由同时接受 UUID 与公开标识；前端 URL/展示/API 切换为 `username` / `display_id` / `public_id`。

**Tech Stack:** Deno 2 + Hono + Drizzle ORM + PostgreSQL；Nuxt 4 + Vue 3 + TypeScript。

**Spec:** `docs/superpowers/specs/2026-08-25-public-identifiers-design.md`

## Global Constraints

- 提交信息与代码注释使用中文（Conventional Commits，scope 如 `core` / `ui`）。
- 使用 `jj` 管理本地提交，禁止 `git add/commit`。
- 所有功能变更必须先完成 OpenSpec 变更提案（Task 1）。
- `deno fmt` / `deno lint` 必须通过；前端 `deno task build` 必须通过。
- 不修改 `drizzle/_journal.json`；迁移由 `deno task db:generate` 生成。
- 后端 API 必须保持 UUID 兼容。
- 公开标识不可变；内部实体（会话/消息/自测/评论/澄清/小题）保持 UUID。
- 短码字符集：`123456789abcdefghjkmnpqrstuvwxyz`；前缀 `ct-`/`tr-`/`sub-`/`post-`/`ann-`。

---

### Task 1: OpenSpec 变更提案

**Files:**
- Create: `openspec/changes/public-identifiers/.openspec.yaml`
- Create: `openspec/changes/public-identifiers/proposal.md`
- Create: `openspec/changes/public-identifiers/design.md`
- Create: `openspec/changes/public-identifiers/tasks.md`

**Interfaces:**
- Consumes: 设计文档 `docs/superpowers/specs/2026-08-25-public-identifiers-design.md`
- Produces: OpenSpec 变更目录，后续任务以该 proposal 为功能依据。

- [ ] **Step 1: 创建 OpenSpec 变更目录与元数据**

创建 `openspec/changes/public-identifiers/.openspec.yaml`：

```yaml
name: public-identifiers
description: 为前端可见实体引入不可变公开标识（public_id），前端含 admin 全面切换，API 保持 UUID 兼容
```

- [ ] **Step 2: 编写 proposal.md**

将设计文档的「背景」「目标」「关键决策」「标识规则」「兼容策略」复制/精简为 `proposal.md`，并列出新增/修改的 OpenSpec spec（建议新增 `public-identifiers`，修订 `database-schema`、`submission-list-api`、`admin-*` 等涉及响应的 spec）。

- [ ] **Step 3: 编写 design.md 与 tasks.md**

- `design.md`：指向 `docs/superpowers/specs/2026-08-25-public-identifiers-design.md`，附关键决策摘要。
- `tasks.md`：把本实施计划的 Task 2–14 列表复制进去，作为 OpenSpec 任务清单。

- [ ] **Step 4: 提交**

```bash
jj describe -m "feat(core): 添加 public identifiers OpenSpec 提案"
jj new -m "wip: public identifiers implementation"
```

---

### Task 2: 后端 public-id 工具库

**Files:**
- Create: `noj-core/src/lib/public-id.ts`
- Test: `noj-core/tests/lib/public-id_test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `const PUBLIC_ID_ALPHABET = "123456789abcdefghjkmnpqrstuvwxyz"`
  - `function isUuid(value: string): boolean`
  - `function generatePublicId(prefix: string, length = 8): string`
  - `function isPublicId(value: string, prefix: string): boolean`

- [ ] **Step 1: 写失败测试**

`noj-core/tests/lib/public-id_test.ts`：

```ts
import { assertEquals, assertFalse, assertTrue } from "@std/assert";
import { generatePublicId, isPublicId, isUuid } from "../../src/lib/public-id.ts";

Deno.test("isUuid 识别标准 UUID", () => {
  assertTrue(isUuid("3f2b8c1e-1a2b-4c3d-8e4f-9a0b1c2d3e4f"));
  assertFalse(isUuid("ct-8f3k2xq"));
});

Deno.test("generatePublicId 使用前缀与字符集", () => {
  const id = generatePublicId("ct");
  assertEquals(id.slice(0, 3), "ct-");
  assertEquals(id.length, 11);
  assertTrue(isPublicId(id, "ct"));
  assertFalse(isPublicId("ct-0O1Il", "ct"));
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd noj-core
deno test tests/lib/public-id_test.ts
```

预期：模块不存在 / 函数未定义。

- [ ] **Step 3: 实现 `lib/public-id.ts`**

```ts
export const PUBLIC_ID_ALPHABET = "123456789abcdefghjkmnpqrstuvwxyz";

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function generatePublicId(prefix: string, length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += PUBLIC_ID_ALPHABET[bytes[i] % PUBLIC_ID_ALPHABET.length];
  }
  return `${prefix}-${out}`;
}

export function isPublicId(value: string, prefix: string): boolean {
  const re = new RegExp(`^${prefix}-[${PUBLIC_ID_ALPHABET}]{8}$`);
  return re.test(value);
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd noj-core
deno test tests/lib/public-id_test.ts
```

- [ ] **Step 5: 提交**

```bash
jj describe -m "feat(core): 添加 public-id 工具库"
jj new -m "wip: public identifiers implementation"
```

---

### Task 3: DB Schema + 迁移 + 回填脚本

**Files:**
- Modify: `noj-core/src/db/schema.ts`
- Create: `noj-core/scripts/backfill-public-ids.ts`
- Generate: `noj-core/drizzle/xxxx_*.sql`（由 `deno task db:generate` 生成）
- Test: `noj-core/tests/scripts/backfill_public_ids_test.ts`（如项目已有脚本测试目录则放入对应目录）

**Interfaces:**
- Consumes: Task 2 `generatePublicId`
- Produces: `contests.public_id`、`trainings.public_id`、`submissions.public_id`、`community_posts.public_id`、`announcements.public_id`（可空 + 唯一索引，回填后非空）

- [ ] **Step 1: 在 schema.ts 为 5 张表添加 public_id 列与唯一索引**

以 `contests` 为例（其余 4 张表同模式）：

```ts
export const contests = pgTable(
  "contests",
  {
    // ... existing columns
    public_id: text("public_id"),
    // ...
  },
  (table) => ({
    // ... existing constraints
    publicIdUnique: unique("contests_public_id_unique").on(table.public_id),
  }),
);
```

- `trainings.public_id` → 唯一索引 `trainings_public_id_unique`
- `submissions.public_id` → 唯一索引 `submissions_public_id_unique`
- `community_posts.public_id` → 唯一索引 `community_posts_public_id_unique`
- `announcements.public_id` → 唯一索引 `announcements_public_id_unique`

- [ ] **Step 2: 生成迁移**

```bash
cd noj-core
deno task db:generate
```

确认生成的 SQL 只包含 5 个新增可空列 + 5 个唯一索引。

- [ ] **Step 3: 编写回填脚本**

`noj-core/scripts/backfill-public-ids.ts`：

```ts
import { getDb } from "../src/db/connection.ts";
import { contests, trainings, submissions, communityPosts, announcements } from "../src/db/schema.ts";
import { eq } from "drizzle-orm";
import { generatePublicId } from "../src/lib/public-id.ts";

async function backfillOne(table: any, prefix: string) {
  const db = getDb();
  const rows = await db.select({ id: table.id, public_id: table.public_id }).from(table);
  for (const row of rows) {
    if (row.public_id) continue;
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = generatePublicId(prefix);
      try {
        await db.update(table).set({ public_id: candidate }).where(eq(table.id, row.id));
        break;
      } catch (err) {
        // 唯一冲突则重试
        if (!String(err).includes("23505")) throw err;
      }
    }
  }
}

export async function backfillAll() {
  await backfillOne(contests, "ct");
  await backfillOne(trainings, "tr");
  await backfillOne(submissions, "sub");
  await backfillOne(communityPosts, "post");
  await backfillOne(announcements, "ann");
}

if (import.meta.main) {
  await backfillAll();
  console.log("backfill done");
}
```

- [ ] **Step 4: 运行回填脚本**

```bash
cd noj-core
deno run -A --env-file=.env scripts/backfill-public-ids.ts
```

预期输出 `backfill done`，且 5 张表不再有空 `public_id`。

- [ ] **Step 5: 将 schema 列改为 NOT NULL 并生成第二个迁移**

修改 schema.ts：5 个 `public_id` 字段改为 `text("public_id").notNull()`，保留唯一索引；再次 `deno task db:generate`，生成 `ALTER COLUMN ... SET NOT NULL` 迁移。

- [ ] **Step 6: 回填脚本幂等测试**

在 `noj-core/tests/` 下增加测试：先插入无 `public_id` 的行，调用 `backfillAll`，断言生成值格式正确且再次运行不改变已有值。

- [ ] **Step 7: 运行迁移与测试**

```bash
cd noj-core
deno task db:migrate
deno task test
```

---

### Task 4: 竞赛（contest）公开标识

**Files:**
- Modify: `noj-core/src/types/contests.ts`
- Modify: `noj-core/src/services/contest/contests.ts`
- Modify: `noj-core/src/routes/contests.ts`
- Test: `noj-core/tests/services/contests.test.ts`、`noj-core/tests/routes/contests.test.ts`

**Interfaces:**
- Consumes: Task 2 `generatePublicId` / `isUuid` / `isPublicId`
- Produces:
  - `ContestResponse.public_id: string`
  - `resolveContestId(value: string): Promise<string>`
  - 所有 `/:id` 路由先用 `resolveContestId` 解析

- [ ] **Step 1: 类型增加 public_id**

`src/types/contests.ts` 的 `ContestResponse` 增加：

```ts
public_id: string;
```

- [ ] **Step 2: 创建时生成 public_id**

在 `createContest` 中：

```ts
const id = crypto.randomUUID();
const publicId = generatePublicId("ct");
// 插入 contests 时增加 public_id: publicId
```

- [ ] **Step 3: 返回响应携带 public_id**

在 `getContest` 返回 `ContestResponse` 的位置增加 `public_id: row.public_id`。若 `toResponse` 是独立函数，在其中补字段。

- [ ] **Step 4: 增加 resolveContestId**

在 `src/services/contest/contests.ts` 新增：

```ts
export async function resolveContestId(value: string): Promise<string> {
  const db = getDb();
  if (isUuid(value)) return value;
  if (!isPublicId(value, "ct")) throw new NotFoundError("竞赛不存在");
  const rows = await db.select({ id: contests.id }).from(contests)
    .where(eq(contests.public_id, value)).limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("竞赛不存在");
  return row.id;
}
```

- [ ] **Step 5: 路由接入 resolveContestId**

在 `routes/contests.ts` 中，对所有 `/:id` 路径参数先执行：

```ts
const contestId = await resolveContestId(c.req.param("id"));
```

替换原来直接 `c.req.param("id")` 的用法（register、problems、ranking、submit、my-submissions、clarifications 等）。

- [ ] **Step 6: 测试**

- `tests/services/contests.test.ts`：创建后 `public_id` 非空；用 `public_id` 能解析到内部 UUID。
- `tests/routes/contests.test.ts`：用 `public_id` 请求 `GET /:id`、`POST /:id/register` 成功；用 UUID 仍成功。

- [ ] **Step 7: 运行测试**

```bash
cd noj-core
deno test tests/services/contests.test.ts tests/routes/contests.test.ts
```

- [ ] **Step 8: 提交**

```bash
jj describe -m "feat(core): 竞赛支持 public_id"
jj new -m "wip: public identifiers implementation"
```

---

### Task 5: 训练（training）公开标识

**Files:**
- Modify: `src/types/trainings.ts`
- Modify: `src/services/trainings.ts`
- Modify: `src/routes/trainings.ts`
- Test: `tests/services/trainings.test.ts`、`tests/routes/trainings.test.ts`

**Interfaces:**
- Consumes: Task 2
- Produces: `TrainingResponse.public_id`、`resolveTrainingId(value: string): Promise<string>`

- [ ] **Step 1: 类型增加 public_id**

`TrainingResponse` 增加 `public_id: string`。

- [ ] **Step 2: 创建时生成**

`createTraining` 增加：

```ts
const publicId = generatePublicId("tr");
// values 中增加 public_id: publicId
```

- [ ] **Step 3: toResponse 增加 public_id**

在 `trainings.ts` 的 `toResponse` 中补 `public_id: row.public_id`。

- [ ] **Step 4: 新增 resolveTrainingId**

```ts
export async function resolveTrainingId(value: string): Promise<string> {
  const db = getDb();
  if (isUuid(value)) return value;
  if (!isPublicId(value, "tr")) throw new NotFoundError("题单不存在");
  const rows = await db.select({ id: trainings.id }).from(trainings)
    .where(eq(trainings.public_id, value)).limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("题单不存在");
  return row.id;
}
```

- [ ] **Step 5: 路由接入**

在 `routes/trainings.ts` 中 `/:id` 相关 handler 最前面加 `const id = await resolveTrainingId(c.req.param("id"));`，后续使用 `id` 代替 `c.req.param("id")`。

- [ ] **Step 6: 测试**

- service：创建后 `public_id` 存在；`resolveTrainingId("tr-...")` 返回 UUID。
- route：`GET /api/v1/trainings/:public_id` 成功；UUID 仍成功。

- [ ] **Step 7: 运行测试并提交**

```bash
cd noj-core
deno test tests/services/trainings.test.ts tests/routes/trainings.test.ts
jj describe -m "feat(core): 训练支持 public_id"
jj new -m "wip: public identifiers implementation"
```

---

### Task 6: 提交（submission）公开标识

**Files:**
- Modify: `src/services/submissions/submissions-types.ts`
- Modify: `src/services/submissions/submissions-crud.ts`
- Modify: `src/routes/submissions.ts`（如存在）
- Modify: `src/routes/admin/admin-submissions.ts`（如存在）
- Test: `tests/services/submissions.test.ts`、`tests/routes/submissions.test.ts`

**Interfaces:**
- Consumes: Task 2
- Produces: `SubmissionResponse.public_id`、`SubmissionDetail.public_id`、`SubmissionListItem.public_id`、`resolveSubmissionId(value: string): Promise<string>`

- [ ] **Step 1: 类型增加 public_id**

在 `submissions-types.ts` 的三个响应接口都加 `public_id: string`。

- [ ] **Step 2: 创建时生成**

在 `submissions-crud.ts` 创建提交处增加：

```ts
const publicId = generatePublicId("sub");
// values 增加 public_id: publicId
```

- [ ] **Step 3: 查询返回 public_id**

所有 select 提交行并映射 DTO 的地方，把 `row.public_id` 放进 `SubmissionResponse` / `SubmissionDetail` / `SubmissionListItem`；`SubmissionListItem.problem` 同时增加 `display_id`（复用已有问题查询）。

- [ ] **Step 4: 新增 resolveSubmissionId**

```ts
export async function resolveSubmissionId(value: string): Promise<string> {
  const db = getDb();
  if (isUuid(value)) return value;
  if (!isPublicId(value, "sub")) throw new NotFoundError("提交不存在");
  const rows = await db.select({ id: submissions.id }).from(submissions)
    .where(eq(submissions.public_id, value)).limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("提交不存在");
  return row.id;
}
```

- [ ] **Step 5: 路由接入**

用户侧 `submissions` 路由和 admin 路由中，对 `/:id` 或 `/:submissionId` 先调用 `resolveSubmissionId`。

- [ ] **Step 6: 测试**

- service：创建提交返回 `public_id`；`resolveSubmissionId("sub-...")` 返回 UUID。
- route：`GET /api/v1/submissions/:public_id` 与 admin 详情/重测/移出队列支持 public_id。

- [ ] **Step 7: 运行测试并提交**

```bash
cd noj-core
deno test tests/services/submissions.test.ts tests/routes/submissions.test.ts
jj describe -m "feat(core): 提交支持 public_id"
jj new -m "wip: public identifiers implementation"
```

---

### Task 7: 社区帖子（post）公开标识

**Files:**
- Modify: `src/db/schema.ts`（community_posts 已在 Task 3 完成）
- Modify: `src/services/community/community-post-crud.ts`
- Modify: `src/routes/community.ts`
- Modify: 社区列表/详情返回类型所在文件（如 `src/services/community/community-post-list.ts` 等）
- Test: `tests/services/community-post.test.ts`、`tests/routes/community.test.ts`

**Interfaces:**
- Consumes: Task 2
- Produces: `PostDetail` / 帖子列表项携带 `post.public_id`；`resolvePostId(value: string): Promise<string>`

- [ ] **Step 1: 创建时生成**

在 `createPost` 的 `post` 对象中增加：

```ts
public_id: generatePublicId("post"),
```

- [ ] **Step 2: 查询返回 public_id**

在 `getPost` 的 select 中增加 `public_id: communityPosts.public_id`；列表查询（`listPosts`、`listBookmarks`、`listFeed` 等）也 select 并返回 `post.public_id`。

- [ ] **Step 3: 新增 resolvePostId**

```ts
export async function resolvePostId(value: string): Promise<string> {
  const db = getDb();
  if (isUuid(value)) return value;
  if (!isPublicId(value, "post")) throw new NotFoundError("社区内容不存在");
  const rows = await db.select({ id: communityPosts.id }).from(communityPosts)
    .where(eq(communityPosts.public_id, value)).limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("社区内容不存在");
  return row.id;
}
```

- [ ] **Step 4: 路由接入**

在 `routes/community.ts` 中，`GET/PATCH/DELETE /posts/:postId`、举报/审核等使用 postId 的 handler 先 `const postId = await resolvePostId(c.req.param("postId"))`。

- [ ] **Step 5: 测试**

- service：创建帖子返回 `public_id`；`resolvePostId("post-...")` 返回 UUID。
- route：`GET /api/v1/community/posts/:public_id` 可用。

- [ ] **Step 6: 运行测试并提交**

```bash
cd noj-core
deno test tests/services/community.test.ts tests/routes/community.test.ts
jj describe -m "feat(core): 社区帖子支持 public_id"
jj new -m "wip: public identifiers implementation"
```

---

### Task 8: 公告（announcement）公开标识

**Files:**
- Modify: `src/services/announcements.ts`
- Modify: `src/routes/announcements.ts`（如存在）
- Modify: `src/routes/admin/announcements.ts`（如存在）
- Test: `tests/services/announcements.test.ts`、`tests/routes/announcements.test.ts`

**Interfaces:**
- Consumes: Task 2
- Produces: `AnnouncementSummary.public_id`、`AnnouncementDetail.public_id`、`AdminAnnouncementItem.public_id`、`resolveAnnouncementId(value: string): Promise<string>`

- [ ] **Step 1: 类型增加 public_id**

在 `announcements.ts` 的 `AnnouncementSummary` / `AnnouncementDetail` / `AdminAnnouncementItem` 加 `public_id: string`。

- [ ] **Step 2: 创建时生成**

`createAnnouncement` 中：

```ts
const publicId = generatePublicId("ann");
// insert 增加 public_id: publicId
```

- [ ] **Step 3: 查询返回 public_id**

`listPublicAnnouncements` / `getPublicAnnouncement` / `listAdminAnnouncements` 的映射中补 `public_id`。

- [ ] **Step 4: 新增 resolveAnnouncementId**

```ts
export async function resolveAnnouncementId(value: string): Promise<string> {
  const db = getDb();
  if (isUuid(value)) return value;
  if (!isPublicId(value, "ann")) throw new NotFoundError("公告不存在");
  const rows = await db.select({ id: announcements.id }).from(announcements)
    .where(eq(announcements.public_id, value)).limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("公告不存在");
  return row.id;
}
```

- [ ] **Step 5: 路由接入**

公开/管理公告路由对 `/:id` 先调用 `resolveAnnouncementId`。

- [ ] **Step 6: 测试并提交**

```bash
cd noj-core
deno test tests/services/announcements.test.ts tests/routes/announcements.test.ts
jj describe -m "feat(core): 公告支持 public_id"
jj new -m "wip: public identifiers implementation"
```

---

### Task 9: 用户（user）公开标识——username 兼容路由

**Files:**
- Modify: `src/routes/users.ts`（或对应文件）
- Modify: `src/services/users/users-profile-queries.ts`（如需要）
- Test: `tests/routes/users.test.ts`

**Interfaces:**
- Consumes: Task 2 `isUuid`
- Produces: `resolveUserId(value: string): Promise<string>`（username 或 UUID）

- [ ] **Step 1: 新增 resolveUserId**

在用户服务/工具中：

```ts
export async function resolveUserId(value: string): Promise<string> {
  const db = getDb();
  if (isUuid(value)) return value;
  const rows = await db.select({ id: users.id }).from(users)
    .where(eq(users.username, value)).limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("用户不存在");
  return row.id;
}
```

- [ ] **Step 2: 路由接入**

`routes/users.ts` 中对 `/:id` 相关 handler 先 `const userId = await resolveUserId(c.req.param("id"))`，再继续原逻辑。

- [ ] **Step 3: 测试**

- `GET /api/v1/users/:username` 返回用户。
- `GET /api/v1/users/:uuid` 仍返回用户。

- [ ] **Step 4: 运行测试并提交**

```bash
cd noj-core
deno test tests/routes/users.test.ts
jj describe -m "feat(core): 用户路由支持 username"
jj new -m "wip: public identifiers implementation"
```

---

### Task 10: 前端类型与 URL 工具

**Files:**
- Create: `noj-ui/utils/publicIdentifiers.ts`
- Modify: `noj-ui/composables/*` 中涉及公开实体的类型定义（`useTrainings.ts`、`useContests.ts`、`use-submissions.ts`、`useCommunity.ts`、`useAuditLogs.ts` 等）
- Test: `noj-ui/tests/publicIdentifiers_test.ts`

**Interfaces:**
- Consumes: 后端返回 `public_id` / `display_id` / `username`
- Produces:
  - `function problemUrl(id: string, displayId?: string): string`
  - `function userUrl(username: string): string`
  - `function publicUrl(kind: "contest" | "training" | "submission" | "post" | "announcement", publicId: string): string`

- [ ] **Step 1: 写失败测试**

`noj-ui/tests/publicIdentifiers_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { problemUrl, userUrl, publicUrl } from "../utils/publicIdentifiers.ts";

Deno.test("problemUrl 优先 display_id", () => {
  assertEquals(problemUrl("uuid", "P100"), "/problems/P100");
  assertEquals(problemUrl("uuid"), "/problems/uuid");
});

Deno.test("userUrl 使用 username", () => {
  assertEquals(userUrl("zhangsan"), "/users/zhangsan");
});

Deno.test("publicUrl 使用前缀", () => {
  assertEquals(publicUrl("submission", "sub-abc12345"), "/submissions/sub-abc12345");
});
```

- [ ] **Step 2: 实现**

`noj-ui/utils/publicIdentifiers.ts`：

```ts
export function problemUrl(id: string, displayId?: string): string {
  return `/problems/${displayId || id}`;
}

export function userUrl(username: string): string {
  return `/users/${username}`;
}

export function publicUrl(
  kind: "contest" | "training" | "submission" | "post" | "announcement",
  publicId: string,
): string {
  const base = {
    contest: "contests",
    training: "trainings",
    submission: "submissions",
    post: "community/posts",
    announcement: "announcements",
  }[kind];
  return `/${base}/${publicId}`;
}
```

- [ ] **Step 3: 运行测试**

```bash
cd noj-ui
deno test tests/publicIdentifiers_test.ts
```

- [ ] **Step 4: 提交**

```bash
jj describe -m "feat(ui): 添加公开标识 URL 工具"
jj new -m "wip: public identifiers implementation"
```

---

### Task 11: 前端用户与题目切换

**Files:**
- Modify: `components/shared/UserIdentity.vue`
- Modify: `components/layout/UserMenu.vue`
- Modify: `components/feature/search/SearchPalette.vue`
- Modify: `components/feature/search/SearchResultItem.vue`
- Modify: `components/card/ProblemCard.vue`
- Modify: `components/feature/RandomProblems.vue`
- Modify: `components/objective/ObjectiveProblemEditor.vue`
- Modify: `pages/settings.vue`
- Modify: `pages/messages/index.vue`
- Modify: `pages/community/notifications.vue`
- Modify: `pages/problems.vue`
- Modify: `pages/my/problems.vue`
- Modify: `pages/users/[id].vue`
- Modify: `pages/problems/[id].vue`
- Modify: `pages/problems/[id]/edit.vue`
- Modify: `pages/submissions/index.vue`
- Modify: `pages/submissions/[id].vue`
- Modify: `pages/editor/[id].vue`
- Modify: `pages/contests/[contestId]/index.vue`
- Modify: `pages/contests/[contestId]/problems/[label].vue`
- Modify: `components/feature/FollowingFeed.vue`
- Test: `noj-ui/tests/publicIdentifiers_test.ts`（已覆盖工具）

**Interfaces:**
- Consumes: Task 10 工具
- Produces: 用户/题目相关链接全部使用 `user.username` / `problem.display_id`

- [ ] **Step 1: 替换用户链接**

把 `UserIdentity.vue`、`UserMenu.vue`、`SearchPalette.vue`、`SearchResultItem.vue`、`settings.vue`、`messages/index.vue`、`community/notifications.vue` 中的 `` `/users/${user.id}` `` 改为 `` userUrl(user.username) ``；`otherUserId` 改为 `otherUsername`（从会话数据取对端用户名）。

- [ ] **Step 2: 替换题目链接**

把 `ProblemCard.vue` 的 `:to="`/problems/${id}`"` 改为 `:to="problemUrl(id, display_id)"`；`problems.vue` 中 `row.original.id` 改为 `problemUrl(row.original.id, row.original.display_id)`；`my/problems.vue`、`users/[id].vue`、`problems/[id].vue`、`submissions/*.vue`、`editor/[id].vue` 同理。

- [ ] **Step 3: 竞赛内题目跳转**

`contests/[contestId]/index.vue` 的 `/editor/${problem.problem_id}` 改为 `/editor/${problem.display_id}`；`contests/[contestId]/problems/[label].vue` 同样处理。

- [ ] **Step 4: 运行前端 lint/build**

```bash
cd noj-ui
deno task lint
deno task build
```

- [ ] **Step 5: 提交**

```bash
jj describe -m "feat(ui): 用户/题目链接切换为可读标识"
jj new -m "wip: public identifiers implementation"
```

---

### Task 12: 前端竞赛/训练/提交/帖子/公告切换

**Files:**
- Modify: `components/feature/training/TrainingCard.vue`
- Modify: `components/feature/contest/ContestRanking.vue`（如 props 改名）
- Modify: `components/feature/QueueRow.vue`
- Modify: `components/card/SubmissionCard.vue`
- Modify: `pages/contests/index.vue`
- Modify: `pages/contests/[contestId]/index.vue`
- Modify: `pages/contests/[contestId]/ranking.vue`
- Modify: `pages/contests/[contestId]/problems/[label].vue`
- Modify: `pages/trainings/index.vue`
- Modify: `pages/trainings/[id].vue`
- Modify: `pages/community/index.vue`
- Modify: `pages/community/bookmarks.vue`
- Modify: `pages/community/posts/[postId].vue`
- Modify: `pages/announcements/index.vue`
- Modify: `pages/index.vue`
- Modify: `pages/submissions/index.vue`
- Modify: `pages/submissions/[id].vue`
- Modify: `pages/users/[id].vue`
- Modify: `pages/editor/[id].vue`
- Modify: `pages/community/notifications.vue`
- Test: `noj-ui/tests/publicIdentifiers_test.ts`（已覆盖 URL）

**Interfaces:**
- Consumes: Task 10
- Produces: 这些实体 URL 全部使用 `public_id`

- [ ] **Step 1: 替换竞赛链接**

`/contests/${contest.id}` → `publicUrl("contest", contest.public_id)`；`/contests/${contestId}` 的 route 参数改为 `contest.public_id`。

- [ ] **Step 2: 替换训练链接**

`/trainings/${training.id}` → `publicUrl("training", training.public_id)`。

- [ ] **Step 3: 替换提交链接**

`/submissions/${submission.id}` → `publicUrl("submission", submission.public_id)`；`QueueRow`、`SubmissionCard`、`submissions/index.vue`、`users/[id].vue`、`editor/[id].vue`、`admin/submissions.vue` 均处理。

- [ ] **Step 4: 替换帖子链接**

`/community/posts/${post.id}` → `publicUrl("post", post.public_id)`；涉及 `post` 对象需在类型中增加 `public_id`。

- [ ] **Step 5: 替换公告链接**

`/announcements/${item.id}` → `publicUrl("announcement", item.public_id)`。

- [ ] **Step 6: 运行 lint/build**

```bash
cd noj-ui
deno task lint
deno task build
```

- [ ] **Step 7: 提交**

```bash
jj describe -m "feat(ui): 竞赛/训练/提交/帖子/公告切换为 public_id"
jj new -m "wip: public identifiers implementation"
```

---

### Task 13: Admin 页面切换 + 展示层清理

**Files:**
- Modify: `pages/admin/problems.vue`
- Modify: `pages/admin/contests.vue`
- Modify: `pages/admin/submissions.vue`
- Modify: `pages/admin/users.vue`
- Modify: `pages/admin/community.vue`
- Modify: `pages/admin/announcements.vue`
- Modify: `pages/admin/tags.vue`
- Modify: `pages/admin/roles.vue`
- Modify: `pages/admin/blacklist.vue`
- Modify: `pages/admin/audit-logs.vue`
- Modify: `pages/admin/llm/usage.vue`
- Modify: `pages/admin/judge-images.vue`
- Modify: `pages/admin/trainings.vue`（如存在）

**Interfaces:**
- Consumes: Task 10–12
- Produces: admin 不再展示/生成 UUID 链接

- [ ] **Step 1: 替换 admin 链接**

`admin/problems.vue` 的 `/admin/problem-edit/${row.original.id}` → `/admin/problem-edit/${row.original.display_id}`；`admin/contests.vue` 的 `/api/v1/admin/contests/${contest.id}` → 使用 `contest.public_id`；`admin/submissions.vue` 的 `/submissions/${rowSub(...).id}` → `public_id`；`admin/users.vue` 等所有公开实体 API/链接同理。

- [ ] **Step 2: 替换删除确认/截断展示**

- `pages/admin/problems.vue`：`deleteTarget.id` → `deleteTarget.display_id`
- `pages/admin/submissions.vue`：`id.slice(0,8)` → `public_id`
- `pages/admin/audit-logs.vue`：target/actor 显示改为可读标识（响应缺少时保留截断 UUID）
- `pages/admin/llm/usage.vue`：`submission_id.slice(0,8)` → `submission.public_id`（响应增加后）
- `components/feature/QueueRow.vue`、`components/card/SubmissionCard.vue`：`#{{ id.slice(0,8) }}` → `#{{ public_id }}`

- [ ] **Step 3: 全仓 grep 校验**

```bash
cd noj-ui
grep -R "slice(0, 8)" pages components --include='*.vue'
grep -R "/\${\([a-zA-Z]*\.\)\?id}" pages components --include='*.vue'
```

预期：公开实体无 UUID 截断、无 UUID 链接；仅内部实体保留。

- [ ] **Step 4: 运行 lint/build/test**

```bash
cd noj-ui
deno task lint
deno task build
deno task test
```

- [ ] **Step 5: 提交**

```bash
jj describe -m "feat(ui): admin 页面切换 public_id 并清理 UUID 展示"
jj new -m "wip: public identifiers implementation"
```

---

### Task 14: 全链路验证

**Files:**
- Modify: 无（仅验证）
- Test: `noj-core`、`noj-ui`、`noj-tests`（如可运行）

**Interfaces:**
- Consumes: 全部 Task
- Produces: 验收结论

- [ ] **Step 1: 后端全量检查**

```bash
cd noj-core
deno fmt --check
deno lint
deno task test
```

- [ ] **Step 2: 前端全量检查**

```bash
cd noj-ui
deno fmt --check
deno lint
deno task build
deno task test
```

- [ ] **Step 3: 交叉验证**

- 手动/脚本验证：`/problems/P100`、`/users/zhangsan`、`/contests/<ct->`、`/trainings/<tr->`、`/submissions/<sub->`、`/community/posts/<post->`、`/announcements/<ann->` 均可访问。
- 旧 UUID 链接仍可访问。

- [ ] **Step 4: 汇总结果**

如发现问题回到对应 Task 修复；全部通过后：

```bash
jj describe -m "feat(core,ui): public identifiers 全链路通过"
```

---

## Self-Review

- **Spec coverage**：Task 2 覆盖解析工具；Task 3 覆盖 DB/迁移/回填；Task 4–9 覆盖后端各实体；Task 10–13 覆盖前端与 admin；Task 14 覆盖验证。与设计文档 §6-§12 对齐。
- **Placeholder scan**：所有步骤均给出具体文件、代码或命令；没有“TBD/TODO”。
- **Type consistency**：`generatePublicId(prefix)` 返回 `prefix-xxxxxxxx`；`publicUrl(kind, publicId)` 统一生成 URL；`resolve*Id` 统一返回内部 UUID。
