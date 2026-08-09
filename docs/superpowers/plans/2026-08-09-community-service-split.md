# community 服务层拆分实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `noj-core/src/services/community.ts`（1582 行 / 44 导出 / 9 私有 helper）拆为 5 个 OpenSpec 子域文件，原文件降为纯 re-export barrel，对外 API 零变更。

**Architecture:** 按 OpenSpec 主规范的 5 个子域（`community-configuration` / `community-content` / `community-moderation` / `community-social-feed` + `community-helpers` 占位）拆分服务层。每个子域文件自包含：自身依赖的 table imports、私有 helper、exported function。`community.ts` 改为 `export * from` 的 barrel，维持现有 5 个 consumer 的 `import { ... } from ".../community.ts"` 路径不变。`tests/services/community.test.ts`（753 行 / 17 个 Deno.test）按子域同步拆分。

**Tech Stack:** Deno 2 + TypeScript（strict 模式）、drizzle-orm、Hono、jsr:@std/assert

## Global Constraints

- **行为零变更**：44 个 export + 9 个 private helper 逐字搬运，不改名 / 不改参 / 不改返回类型 / 不改函数体
- **公开 API 零变更**：所有现有 `import { ... } from ".../services/community.ts"` 调用方无需修改
- **数据库 schema 零变更**：不触 `db/schema.ts` 与 `db/schema-ddl.ts`
- **审计日志语义零变更**：`logAudit` 调用位置与 action 名不变
- **SSE 广播零变更**：`publishEvent(Channels.*, ...)` 调用位置不变
- **OpenSpec 主规范零变更**：行为不变，规范层面已是子域化
- **测试守恒**：拆分前后 `Deno.test()` 数（17）+ 断言数严格相等，不允许新增/删除/修改用例
- **每步后必须 green**：`deno fmt && deno lint && deno check && deno task test` 全部通过方可进入下一步
- **GPG 签名**：每个 commit 必须用 EDDSA key `F27B5D0A639B43695413D9440F49774CB31F6CF1` 签名
- **commit message**：中文 Conventional Commits；scope 仅 `core`；type 仅 `refactor`
- **不在本计划范围**：拆分 `routes/community.ts`（P1，后续 PR）、`routes/admin.ts`（P1，后续 PR）、`db/schema.ts`（Drizzle relational API 约束）、OpenSpec 主规范修改

**关键文件路径参考**：
- 服务源：`noj-core/src/services/community.ts`
- 服务目标：`noj-core/src/services/community-{config,content,social-feed,moderation,helpers}.ts`
- 测试源：`noj-core/tests/services/community.test.ts`
- 测试目标：`noj-core/tests/services/community-{config,content,social-feed,moderation}.test.ts`
- 类型参考：`noj-core/src/types/community.ts`（已独立，59 行，不触）
- 表参考：`noj-core/src/db/schema.ts`（不触）
- 既有 consumer：`noj-core/src/routes/{community,conversations,contests,search}.ts` + `noj-core/tests/routes/search.test.ts`

---

### Task 1：迁移 content 子域（18 导出 + 3 私有 helper）

**Files:**
- Create: `noj-core/src/services/community-content.ts`（约 660 行）
- Modify: `noj-core/src/services/community.ts`（移除约 660 行，添加 1 行 re-export）

**Interfaces:**
- Consumes: `communityPostLikes`, `communityBookmarks`, `communityCommentLikes`, `communityFollows`, `communityPosts`, `communityComments`, `users`, `evaluationResults`, `problems`, `submissions`（from `../db/schema.ts`）；`getDb`（from `../db/connection.ts`）；`CommunityConfig`, `CommunityPostInput`, `CommunityPostStatus`, `CommunityPostType`（from `../types/community.ts`）；`Channels`, `publishEvent`（from `../lib/event-bus.ts`）；`ConflictError`, `ForbiddenError`, `NotFoundError`, `ValidationError`（from `../lib/errors.ts`）；`getSetting`, `reloadSingleKey`（from `./system-settings.ts`）；`logAudit`（from `./audit-log.ts`）；`getRequestContext`（from `../lib/request-context.ts`）；`nowIso`（from `../lib/dates.ts`）
- Produces: 18 个 export（`createPost`, `getPost`, `listPosts`, `countPostsByType`, `listBookmarks`, `updatePost`, `changePostStatus`, `togglePostFlag`, `createComment`, `listComments`, `listPendingComments`, `updateComment`, `deleteComment`, `changeCommentStatus`, `togglePostLike`, `toggleBookmark`, `toggleCommentLike`, `toggleFollow`）+ 3 个 private helper（`publicationStatus`, `canPostToBoard`, `toggleRelation`）。下游 consumer 通过 barrel `community.ts` 透明访问。

- [ ] **Step 1：创建 `community-content.ts` 并搬运私有 helper**

创建新文件 `noj-core/src/services/community-content.ts`：

```ts
/**
 * community 内容子域：posts / comments / 互动（likes / bookmarks / follows）。
 * 对应 OpenSpec spec: openspec/specs/community-content/spec.md
 */

import { and, desc, eq, ilike, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  communityBookmarks,
  communityCommentLikes,
  communityComments,
  communityFollows,
  communityPostLikes,
  communityPosts,
  evaluationResults,
  problems,
  submissions,
  users,
} from "../db/schema.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../lib/errors.ts";
import { Channels, publishEvent } from "../lib/event-bus.ts";
import { logAudit } from "./audit-log.ts";
import { getSetting, reloadSingleKey } from "./system-settings.ts";
import type {
  CommunityConfig,
  CommunityPostInput,
  CommunityPostStatus,
  CommunityPostType,
} from "../types/community.ts";
import { nowIso } from "../lib/dates.ts";
```

然后从 `community.ts` 第 131-148 行（`publicationStatus`）、第 312-325 行（`canPostToBoard`）、第 986-1007 行（`toggleRelation`）逐字复制三个私有 helper 到新文件底部（保持 `function` 顺序：先 `publicationStatus`，再 `canPostToBoard`，再 `toggleRelation`）。

- [ ] **Step 2：运行 `deno check` 验证 helpers 编译通过**

Run: `cd noj-core && deno check src/services/community-content.ts`
Expected: 无错误（PASS）。注意：`community.ts` 仍含原始 helper，类型层面无重复（不同 module 各自独立）。

- [ ] **Step 3：搬运 posts 相关 export 函数**

从 `community.ts` 复制以下 8 个函数到 `community-content.ts`（按文件中先后顺序逐字复制函数体，包括 JSDoc 注释）：

| 函数 | 起始行 |
|------|------:|
| `createPost` | 327 |
| `getPost` | 419 |
| `listPosts` | 462 |
| `countPostsByType` | 547 |
| `listBookmarks` | 578 |
| `updatePost` | 617 |
| `changePostStatus` | 653 |
| `changeCommentStatus` | 703 |
| `togglePostFlag` | 773 |

放置位置：在 `community-content.ts` 中已有 helpers 之后。

- [ ] **Step 4：搬运 comments 相关 export 函数**

从 `community.ts` 复制以下 6 个函数到 `community-content.ts`：

| 函数 | 起始行 |
|------|------:|
| `createComment` | 807 |
| `listComments` | 866 |
| `listPendingComments` | 901 |
| `updateComment` | 920 |
| `deleteComment` | 950 |
| （`changeCommentStatus` 已在 Step 3 复制） | — |

- [ ] **Step 5：搬运 interactions（likes / bookmarks / follows）相关 export**

从 `community.ts` 复制以下 4 个函数到 `community-content.ts`：

| 函数 | 起始行 |
|------|------:|
| `togglePostLike` | 1009 |
| `toggleBookmark` | 1030 |
| `toggleCommentLike` | 1037 |
| `toggleFollow` | 1084 |

- [ ] **Step 6：运行 `deno check` 验证新文件类型完整**

Run: `cd noj-core && deno check src/services/community-content.ts`
Expected: 无错误（PASS）。

- [ ] **Step 7：从 `community.ts` 移除 content 函数并添加 barrel re-export**

修改 `noj-core/src/services/community.ts`：

1. 删除第 131-148 行（`publicationStatus`）、第 312-325 行（`canPostToBoard`）、第 327-1100 行的所有 content 相关函数（`createPost` 到 `toggleFollow`，含 `changeCommentStatus`、`togglePostFlag`）。
2. 删除 `toggleRelation`（第 986-1007 行）。
3. 删除现在不再需要的 imports：`communityBookmarks`, `communityCommentLikes`, `communityComments`, `communityFollows`, `communityPostLikes`, `communityPosts`（注意 `communityBoards` / `communityBoardRoleGrants` 仍需保留给后续 Task）。
4. 在文件顶部 import 区域后、第 1 个保留函数之前，添加一行：

```ts
export * from "./community-content.ts";
```

- [ ] **Step 8：运行完整验证链**

Run:
```bash
cd noj-core && deno fmt && deno lint && deno check && deno task test
```
Expected: 全部 PASS；测试数不变（743 passed）；`community.ts` 当前仅含 config / feed / moderation 的函数。

- [ ] **Step 9：commit**

```bash
git add noj-core/src/services/community.ts noj-core/src/services/community-content.ts
git commit -m "refactor(core): 拆分 community 服务 — 迁移 content 子域（posts/comments/互动）" -S
```

Expected: GPG 签名通过（`git log --format="%G?" -1` 显示 `G`）。

---

### Task 2：迁移 config 子域（11 导出 + 4 私有 helper）

**Files:**
- Create: `noj-core/src/services/community-config.ts`（约 240 行）
- Modify: `noj-core/src/services/community.ts`（移除约 240 行，添加 1 行 re-export）

**Interfaces:**
- Consumes: `communityBoards`, `communityBoardRoleGrants`, `users`（from `../db/schema.ts`）；`getDb`（from `../db/connection.ts`）；`CommunityConfig`, `CommunityPostType`（from `../types/community.ts`）；`ConflictError`, `ForbiddenError`, `NotFoundError`, `ValidationError`（from `../lib/errors.ts`）；`getSetting`, `updateSetting`, `reloadSingleKey`（from `./system-settings.ts`）；`logAudit`（from `./audit-log.ts`）；`ROOT_USER_ID`（from `../lib/constants.ts`）；`nowIso`（from `../lib/dates.ts`）
- Produces: 11 个 export（`getCommunityConfig`, `assertCommunityEnabled`, `assertCommunityWritable`, `resolveProblemId`, `hasAcceptedSolution`, `listBoards`, `createBoard`, `updateBoard`, `listBoardRoleGrants`, `updateBoardRoleGrant`, `deleteBoardRoleGrant`）+ 4 个 private helper（`settingBoolean`, `settingNumber`, `featureForType`, `ensureSolutionAccepted`）

- [ ] **Step 1：创建 `community-config.ts` 并搬运私有 helper**

创建新文件 `noj-core/src/services/community-config.ts`，写入 imports：

```ts
/**
 * community 配置子域：板块管理 + 资格校验 + 配置读取。
 * 对应 OpenSpec spec: openspec/specs/community-configuration/spec.md
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  communityBoardRoleGrants,
  communityBoards,
  evaluationResults,
  problems,
  submissions,
  userRoles,
  users,
} from "../db/schema.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../lib/errors.ts";
import { logAudit } from "./audit-log.ts";
import { getSetting, reloadSingleKey, updateSetting } from "./system-settings.ts";
import type {
  CommunityConfig,
  CommunityPostType,
} from "../types/community.ts";
import { ROOT_USER_ID } from "../lib/constants.ts";
import { nowIso } from "../lib/dates.ts";
```

然后从 `community.ts` 复制以下私有 helper 到新文件：
- 第 56-58 行（`settingBoolean`）
- 第 60-62 行（`settingNumber`）
- 第 123-128 行（`featureForType`）
- 第 188-201 行（`ensureSolutionAccepted`）

- [ ] **Step 2：搬运 config + boards 相关 export 函数**

从 `community.ts` 复制以下 11 个函数到 `community-config.ts`（按文件中先后顺序）：

| 函数 | 起始行 |
|------|------:|
| `getCommunityConfig` | 65 |
| `assertCommunityEnabled` | 93 |
| `assertCommunityWritable` | 100 |
| `resolveProblemId` | 150 |
| `hasAcceptedSolution` | 202 |
| `listBoards` | 220 |
| `createBoard` | 227 |
| `updateBoard` | 251 |
| `listBoardRoleGrants` | 271 |
| `updateBoardRoleGrant` | 278 |
| `deleteBoardRoleGrant` | 304 |

- [ ] **Step 3：运行 `deno check` 验证新文件**

Run: `cd noj-core && deno check src/services/community-config.ts`
Expected: 无错误（PASS）。

- [ ] **Step 4：从 `community.ts` 移除 config 函数并添加 barrel re-export**

修改 `community.ts`：
1. 删除第 56-62 行（`settingBoolean` / `settingNumber`）、第 65-91 行（`getCommunityConfig`）、第 93-98 行（`assertCommunityEnabled`）、第 100-122 行（`assertCommunityWritable`）、第 123-128 行（`featureForType`）、第 150-186 行（`resolveProblemId`）、第 188-201 行（`ensureSolutionAccepted`）、第 202-218 行（`hasAcceptedSolution`）、第 220-325 行（`listBoards` 到 `deleteBoardRoleGrant`）。
2. 删除不再需要的 imports：`communityBoards`, `communityBoardRoleGrants`, `evaluationResults`, `problems`, `submissions`, `userRoles`（保留 `users` 因 moderation 仍用）。
3. 在已有 `export * from "./community-content.ts"` 后追加：

```ts
export * from "./community-config.ts";
```

- [ ] **Step 5：运行完整验证链**

Run:
```bash
cd noj-core && deno fmt && deno lint && deno check && deno task test
```
Expected: 全部 PASS；`community.ts` 当前仅含 feed + moderation 函数。

- [ ] **Step 6：commit**

```bash
git add noj-core/src/services/community.ts noj-core/src/services/community-config.ts
git commit -m "refactor(core): 拆分 community 服务 — 迁移 config 子域（boards/资格/配置）" -S
```

---

### Task 3：迁移 social-feed 子域（3 导出 + 1 私有 helper）

**Files:**
- Create: `noj-core/src/services/community-social-feed.ts`（约 240 行）
- Modify: `noj-core/src/services/community.ts`（移除约 240 行，添加 1 行 re-export）

**Interfaces:**
- Consumes: `communityActivityEvents`, `communityFollows`, `communityNotifications`, `communityPosts`, `communityComments`, `users`（from `../db/schema.ts`）；`getDb`（from `../db/connection.ts`）；`CommunityConfig`, `CommunityPostType`（from `../types/community.ts`）；`Channels`, `publishEvent`（from `../lib/event-bus.ts`）；`ForbiddenError`, `ValidationError`（from `../lib/errors.ts`）；`logAudit`（from `./audit-log.ts`）；`nowIso`（from `../lib/dates.ts`）
- Produces: 3 个 export（`updateActivityVisibility`, `createActivity`, `listFeed`）+ 1 个 private helper（`parseFeedCursor`）

- [ ] **Step 1：创建 `community-social-feed.ts`**

创建新文件 `noj-core/src/services/community-social-feed.ts`：

```ts
/**
 * community 社交动态子域：用户关注、活动流、游标分页。
 * 对应 OpenSpec spec: openspec/specs/community-social-feed/spec.md
 */

import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  communityActivityEvents,
  communityFollows,
  communityNotifications,
  communityPosts,
  communityComments,
  users,
} from "../db/schema.ts";
import { ForbiddenError, ValidationError } from "../lib/errors.ts";
import { Channels, publishEvent } from "../lib/event-bus.ts";
import { logAudit } from "./audit-log.ts";
import type { CommunityConfig, CommunityPostType } from "../types/community.ts";
import { nowIso } from "../lib/dates.ts";
```

- [ ] **Step 2：搬运 `parseFeedCursor` 私有 helper 与 3 个 export**

从 `community.ts` 复制：
- 第 1278-1282 行（`parseFeedCursor`，private）
- 第 1114-1128 行（`updateActivityVisibility`）
- 第 1130-1148 行（`createActivity`）
- 第 1150-1276 行（`listFeed`）

放置顺序：先 `parseFeedCursor` helper，再 3 个 export。

- [ ] **Step 3：运行 `deno check`**

Run: `cd noj-core && deno check src/services/community-social-feed.ts`
Expected: PASS。

- [ ] **Step 4：从 `community.ts` 移除 social-feed 函数并添加 barrel re-export**

修改 `community.ts`：
1. 删除第 1114-1276 行的 `updateActivityVisibility` / `createActivity` / `listFeed`。
2. 删除第 1278-1282 行的 `parseFeedCursor`。
3. 删除不再需要的 imports：`communityActivityEvents`, `communityFollows`（其他 feed 相关 table 仍在 moderation 使用）。
4. 在已有 re-export 后追加：

```ts
export * from "./community-social-feed.ts";
```

- [ ] **Step 5：运行完整验证链**

Run:
```bash
cd noj-core && deno fmt && deno lint && deno check && deno task test
```
Expected: 全部 PASS；`community.ts` 当前仅含 moderation 函数。

- [ ] **Step 6：commit**

```bash
git add noj-core/src/services/community.ts noj-core/src/services/community-social-feed.ts
git commit -m "refactor(core): 拆分 community 服务 — 迁移 social-feed 子域（活动/动态）" -S
```

---

### Task 4：迁移 moderation 子域（12 导出 + 1 私有 helper）

**Files:**
- Create: `noj-core/src/services/community-moderation.ts`（约 260 行）
- Modify: `noj-core/src/services/community.ts`（移除约 260 行，添加 1 行 re-export）

**Interfaces:**
- Consumes: `communityBookmarks`, `communityCommentLikes`, `communityComments`, `communityModerationActions`, `communityNotifications`, `communityPostLikes`, `communityPosts`, `communityReports`, `communitySanctions`, `users`（from `../db/schema.ts`）；`getDb`（from `../db/connection.ts`）；`CommunityConfig`, `CommunityPostStatus`, `CommunityPostType`（from `../types/community.ts`）；`Channels`, `publishEvent`（from `../lib/event-bus.ts`）；`ForbiddenError`, `NotFoundError`, `ValidationError`（from `../lib/errors.ts`）；`getSetting`, `reloadSingleKey`, `updateSetting`（from `./system-settings.ts`）；`logAudit`（from `./audit-log.ts`）；`nowIso`（from `../lib/dates.ts`）
- Produces: 12 个 export（`listNotifications`, `getNotificationUnreadCount`, `markNotificationsRead`, `markNotificationRead`, `createReport`, `listReports`, `resolveReport`, `createSanction`, `revokeSanction`, `listSanctions`, `listUserSanctions`, `applyCommunityPreset`）+ 1 个 private helper（`createNotification`）

- [ ] **Step 1：创建 `community-moderation.ts`**

创建新文件 `noj-core/src/services/community-moderation.ts`：

```ts
/**
 * community 审核治理子域：通知 / 举报 / 处罚 / 预设。
 * 对应 OpenSpec spec: openspec/specs/community-moderation/spec.md
 */

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  communityBookmarks,
  communityCommentLikes,
  communityComments,
  communityModerationActions,
  communityNotifications,
  communityPostLikes,
  communityPosts,
  communityReports,
  communitySanctions,
  users,
} from "../db/schema.ts";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../lib/errors.ts";
import { Channels, publishEvent } from "../lib/event-bus.ts";
import { logAudit } from "./audit-log.ts";
import {
  getSetting,
  reloadSingleKey,
  updateSetting,
} from "./system-settings.ts";
import type {
  CommunityConfig,
  CommunityPostStatus,
  CommunityPostType,
} from "../types/community.ts";
import { nowIso } from "../lib/dates.ts";
```

- [ ] **Step 2：搬运 `createNotification` 私有 helper**

从 `community.ts` 复制第 1284-1313 行（`createNotification`）。

- [ ] **Step 3：搬运 notifications 相关 export**

从 `community.ts` 复制以下 4 个函数到 `community-moderation.ts`：
- 第 1315-1325 行（`listNotifications`）
- 第 1327-1337 行（`getNotificationUnreadCount`）
- 第 1339-1347 行（`markNotificationsRead`）
- 第 1349-1366 行（`markNotificationRead`）

- [ ] **Step 4：搬运 reports / sanctions / preset 相关 export**

从 `community.ts` 复制以下 8 个函数：
- 第 1368-1423 行（`createReport`）
- 第 1425-1429 行（`listReports`）
- 第 1431-1451 行（`resolveReport`）
- 第 1453-1480 行（`createSanction`）
- 第 1482-1494 行（`revokeSanction`）
- 第 1496-1501 行（`listSanctions`）
- 第 1503-1558 行（`listUserSanctions`）
- 第 1560-1582 行（`applyCommunityPreset`）

- [ ] **Step 5：运行 `deno check`**

Run: `cd noj-core && deno check src/services/community-moderation.ts`
Expected: PASS。

- [ ] **Step 6：从 `community.ts` 移除 moderation 函数并添加 barrel re-export**

修改 `community.ts`：
1. 删除第 1284-1313 行（`createNotification`）。
2. 删除第 1315-1582 行的所有 moderation 函数（`listNotifications` 到 `applyCommunityPreset`）。
3. 删除现在不再需要的 imports：`communityBookmarks`, `communityCommentLikes`, `communityComments`, `communityModerationActions`, `communityNotifications`, `communityPostLikes`, `communityPosts`, `communityReports`, `communitySanctions`, `users`。
4. 在已有 re-export 后追加：

```ts
export * from "./community-moderation.ts";
```

5. 验证 `community.ts` 仅剩 4 行 re-export（如未达到则保留 import 与必要的类型引用）。

- [ ] **Step 7：运行完整验证链**

Run:
```bash
cd noj-core && deno fmt && deno lint && deno check && deno task test
```
Expected: 全部 PASS；`community.ts` 应已 < 20 行（4 行 re-export + 注释 + 必要 import）。

- [ ] **Step 8：commit**

```bash
git add noj-core/src/services/community.ts noj-core/src/services/community-moderation.ts
git commit -m "refactor(core): 拆分 community 服务 — 迁移 moderation 子域（通知/举报/处罚）" -S
```

---

### Task 5：创建 `community-helpers.ts` 占位文件

**Files:**
- Create: `noj-core/src/services/community-helpers.ts`（约 15-20 行）

**Interfaces:**
- Consumes: 无（占位文件）
- Produces: 文件头 JSDoc 说明 + 占位常量（无强制 export；若添加常量则 export）

- [ ] **Step 1：创建 `community-helpers.ts`**

创建新文件 `noj-core/src/services/community-helpers.ts`：

```ts
/**
 * community 跨子域共享工具与常量。
 *
 * 当前所有跨子域 helper 已分别归属到对应子域文件（详见 docs/superpowers/specs/
 * 2026-08-09-community-service-split-design.md §4）。本文件保留为未来跨子域
 * 共享常量（如 DEFAULT_FEED_PAGE_SIZE、NOTIFICATION_DEFAULT_LIMIT 等）的
 * 归属位，避免新 helper 出现时反复决策子域归属。
 */

export const COMMUNITY_HELPERS_VERSION = 1;
```

- [ ] **Step 2：验证无 lint 警告**

Run: `cd noj-core && deno lint src/services/community-helpers.ts`
Expected: PASS（无 unused export 警告，因为 `COMMUNITY_HELPERS_VERSION` 是 module-level export，会被静态分析识别）。

- [ ] **Step 3：commit**

```bash
git add noj-core/src/services/community-helpers.ts
git commit -m "refactor(core): 拆分 community 服务 — 添加 helpers 占位文件" -S
```

---

### Task 6：验证 `community.ts` 为纯 barrel

**Files:**
- Modify: `noj-core/src/services/community.ts`（如有必要，清理）

- [ ] **Step 1：检查 `community.ts` 行数与内容**

Run:
```bash
wc -l noj-core/src/services/community.ts && cat noj-core/src/services/community.ts
```
Expected: < 25 行；内容仅含文件头注释 + 4 行 `export * from "./community-*.ts"` re-export。如存在多余 imports / 残留函数体，按需删除。

- [ ] **Step 2：替换为标准 barrel 内容（如未达标）**

若 `community.ts` 不符合纯 barrel 形态，将其替换为：

```ts
/**
 * community 服务层 barrel（向后兼容）。
 *
 * 实际实现已拆分到 OpenSpec 子域文件，新代码请直接 import 子域文件以避免
 * 间接层（如需使用 createPost，请 import "./community-content.ts"）。
 *
 * OpenSpec 子域对应：
 *   - community-configuration → ./community-config.ts
 *   - community-content       → ./community-content.ts
 *   - community-moderation    → ./community-moderation.ts
 *   - community-social-feed   → ./community-social-feed.ts
 */

export * from "./community-config.ts";
export * from "./community-content.ts";
export * from "./community-social-feed.ts";
export * from "./community-moderation.ts";
```

- [ ] **Step 3：运行完整验证链**

Run:
```bash
cd noj-core && deno fmt && deno lint && deno check && deno task test
```
Expected: 全部 PASS；现有 5 个 consumer（`routes/community.ts` / `routes/conversations.ts` / `routes/contests.ts` / `routes/search.ts` / `tests/services/community.test.ts`）零修改可继续工作。

- [ ] **Step 4：commit（如有修改）**

```bash
git add noj-core/src/services/community.ts
git commit -m "refactor(core): 拆分 community 服务 — 标准化 barrel" -S
```

若无修改则跳过此步。

---

### Task 7：拆分测试文件

**Files:**
- Create: `noj-core/tests/services/community-{config,content,social-feed,moderation}.test.ts`（约 750 行总计，按原文件比例）
- Delete: `noj-core/tests/services/community.test.ts`（753 行）

**Interfaces:**
- Consumes: 每个新测试文件从对应的子域服务文件 import（如 `community-content.test.ts` 从 `../../src/services/community-content.ts` import），不再走 barrel；保留 `getDb`, `resetDbForTest`, `ensureRbacSeeds` 等既有 helpers
- Produces: 17 个 `Deno.test()` 块，按子域分配到 4 个新文件

- [ ] **Step 1：列出 17 个测试的子域归属**

按测试名（`community.ts` 行号）映射到子域：

| 测试名（`community service: ...`） | 原行号 | 归属 |
|----------------------------------|------:|------|
| 活动去重并显示在最新动态流 | 109 | social-feed |
| 讨论互动仅允许一级回复 | 129 | content |
| 收藏列表仅返回自己的已发布内容 | 161 | content |
| 板块角色授权限制发帖 | 206 | config（boards） |
| 社区处罚写入审计且不影响独立记录 | 243 | moderation |
| 预设切换即时收紧社区能力 | 270 | moderation |
| 题目不存在拒绝题解，未通过题目仍受门槛限制 | 297 | config（eligibility） |
| 编辑内容同样受长度限制约束 | 330 | content |
| 仅允许回复已发布评论，待审评论可被审核批准 | 354 | content（comments） |
| 评论点赞通知被赞者且校验评论存在 | 427 | content + moderation 边界 → content（主断言在评论点赞） |
| 待审评论进入审核队列 | 455 | content |
| 预审发布通知作者且处罚阻止社区写入 | 488 | moderation |
| 隐藏活动不进入他人的动态流，举报可处置且拒绝重复 | 526 | social-feed + moderation 边界 → moderation（主断言在举报处置） |
| 发布频率限制与题解门槛豁免审核员 | 576 | content（rate-limit） |
| 作者可见自己的待审评论，模块关闭时详情 403 | 647 | content |
| 动态流复合游标翻页不重复不丢失 | 693 | social-feed |
| 点赞已删除评论返回 404 | 733 | content |

合计：config 2 个 + content 8 个 + social-feed 2 个 + moderation 3 个 + 边界归属 content 1 个 + 边界归属 moderation 1 个 = 17 ✓

- [ ] **Step 2：创建 `tests/services/community-config.test.ts`**

创建新文件，包含原文件中以下测试（按行号顺序）：
- 第 206 行起 `板块角色授权限制发帖`
- 第 297 行起 `题目不存在拒绝题解，未通过题目仍受门槛限制`

Imports 改为：

```ts
import {
  // ... 仅 config 相关函数
  createBoard,
  resolveProblemId,
  // ...
} from "../../src/services/community-config.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { ensureRbacSeeds } from "../../src/services/seed-rbac.ts";
// 其他 lib/db 依赖保持
```

每个测试的 `name: "community service: ..."` 改为 `name: "community-config service: ..."`（替换前缀以反映新归属）。

- [ ] **Step 3：创建 `tests/services/community-content.test.ts`**

创建新文件，包含原文件中以下测试（按行号顺序）：
- 第 129 行起 `讨论互动仅允许一级回复`
- 第 161 行起 `收藏列表仅返回自己的已发布内容`
- 第 330 行起 `编辑内容同样受长度限制约束`
- 第 354 行起 `仅允许回复已发布评论，待审评论可被审核批准`
- 第 427 行起 `评论点赞通知被赞者且校验评论存在`
- 第 455 行起 `待审评论进入审核队列`
- 第 576 行起 `发布频率限制与题解门槛豁免审核员`
- 第 647 行起 `作者可见自己的待审评论，模块关闭时详情 403`
- 第 733 行起 `点赞已删除评论返回 404`

Imports 改为从 `../../src/services/community-content.ts` 导入 content 相关函数；测试名前缀改为 `community-content service: ...`。

- [ ] **Step 4：创建 `tests/services/community-social-feed.test.ts`**

创建新文件，包含原文件中以下测试：
- 第 109 行起 `活动去重并显示在最新动态流`
- 第 693 行起 `动态流复合游标翻页不重复不丢失`

Imports 改为从 `../../src/services/community-social-feed.ts` 导入；测试名前缀改为 `community-social-feed service: ...`。

- [ ] **Step 5：创建 `tests/services/community-moderation.test.ts`**

创建新文件，包含原文件中以下测试：
- 第 243 行起 `社区处罚写入审计且不影响独立记录`
- 第 270 行起 `预设切换即时收紧社区能力`
- 第 488 行起 `预审发布通知作者且处罚阻止社区写入`
- 第 526 行起 `隐藏活动不进入他人的动态流，举报可处置且拒绝重复`

Imports 改为从 `../../src/services/community-moderation.ts` 导入；测试名前缀改为 `community-moderation service: ...`。

- [ ] **Step 6：运行 4 个新测试文件**

Run:
```bash
cd noj-core && deno test -A tests/services/community-config.test.ts tests/services/community-content.test.ts tests/services/community-social-feed.test.ts tests/services/community-moderation.test.ts
```
Expected: 全部 PASS；新文件合计 17 个 test 通过（与原文件 test 数守恒）。

- [ ] **Step 7：删除原 `tests/services/community.test.ts`**

Run:
```bash
rm noj-core/tests/services/community.test.ts
```

- [ ] **Step 8：运行完整验证链**

Run:
```bash
cd noj-core && deno fmt && deno lint && deno check && deno task test
```
Expected: 全部 PASS；测试总数不变（仍 743 passed）；4 个新测试文件覆盖原 17 个用例的断言集合。

- [ ] **Step 9：commit**

```bash
git add noj-core/tests/services/community-{config,content,social-feed,moderation}.test.ts
git rm noj-core/tests/services/community.test.ts
git commit -m "refactor(core): 拆分 community 服务测试 — 按子域同步拆分 17 个用例" -S
```

---

### Task 8：最终验证 + OpenSpec 一致性检查

**Files:** 不修改代码，仅验证

- [ ] **Step 1：验证现有 5 个 consumer 零修改**

Run:
```bash
git diff main -- 'noj-core/src/routes/community.ts' 'noj-core/src/routes/conversations.ts' 'noj-core/src/routes/contests.ts' 'noj-core/src/routes/search.ts' 'noj-core/tests/routes/search.test.ts'
```
Expected: 5 个文件均无 diff（git diff 输出为空）。如有 diff，说明拆分破坏了 API — 立即停止并回滚。

- [ ] **Step 2：验证 OpenSpec 主规范零修改**

Run:
```bash
git diff main -- 'openspec/specs/community-*/spec.md'
```
Expected: 5 个 OpenSpec 主规范文件均无 diff（行为零变更，规范本就是子域化）。

- [ ] **Step 3：验证服务文件粒度**

Run:
```bash
wc -l noj-core/src/services/community*.ts
```
Expected：
- `community.ts` ≤ 25 行（barrel）
- `community-config.ts` ≈ 240 行
- `community-content.ts` ≈ 660 行
- `community-social-feed.ts` ≈ 240 行
- `community-moderation.ts` ≈ 260 行
- `community-helpers.ts` ≈ 15-20 行
- `community-seed.ts` 不变（32 行）

如 `community-content.ts` 显著超过 700 行或 `community-config.ts` 超过 350 行，提示 Task 1/2 有冗余 imports 未清理。

- [ ] **Step 4：验证 drizzle schema 零变更**

Run:
```bash
git diff main -- 'noj-core/src/db/schema.ts' 'noj-core/drizzle/'
```
Expected: 无 diff（schema 拆分不应触及）。

- [ ] **Step 5：最终全量验证**

Run:
```bash
cd noj-core && deno fmt --check && deno lint && deno check && deno task test
```
Expected: 全部 PASS。

- [ ] **Step 6：commit 验证结果（如需）**

如本任务中未做任何代码修改，无需 commit。如修改了 `community.ts`（Task 6 残留），按 Task 6 Step 4 流程 commit。

---

### Task 9：推送分支 + 创建 PR

**Files:** PR body（文本）

- [ ] **Step 1：推送分支到远端**

```bash
jj git push -b community-service-split
```
或：
```bash
git push -u origin community-service-split
```

- [ ] **Step 2：使用 gh CLI 创建 Draft PR**

```bash
gh pr create --draft --base main --head community-service-split \
  --title "refactor(core): 拆分 community 服务层为 OpenSpec 子域文件" \
  --body-file - <<'EOF'
## 变更摘要

按 OpenSpec 主规范的 5 个子域拆分 `noj-core/src/services/community.ts`（1582 行）为 5 个聚焦文件（每文件 < 700 行）：

- `community-config.ts` — boards / 资格校验 / 配置读取（OpenSpec `community-configuration`）
- `community-content.ts` — posts / comments / 互动（OpenSpec `community-content`）
- `community-social-feed.ts` — activity / feed / follows（OpenSpec `community-social-feed`）
- `community-moderation.ts` — 通知 / 举报 / 处罚 / 预设（OpenSpec `community-moderation`）
- `community-helpers.ts` — 跨子域共享工具占位

`community.ts` 降为纯 re-export barrel（< 25 行），维持现有 5 个 consumer 的 import 路径零修改。

## 不变更

- 公开 API 签名（44 个 export + 9 个私有 helper 逐字搬运）
- 数据库 schema
- 审计日志语义
- SSE 广播事件
- OpenSpec 主规范（行为零变更）
- 现有 5 个 consumer 文件（`routes/{community,conversations,contests,search}.ts` + `tests/routes/search.test.ts`）

## 验证

- [x] `deno fmt && deno lint` 无警告
- [x] `deno task test` 743 passed / 0 failed（与拆分前数量守恒）
- [x] `git diff main -- openspec/` 零行
- [x] `git diff main -- noj-core/src/db/schema.ts` 零行

## 设计文档

`docs/superpowers/specs/2026-08-09-community-service-split-design.md`

## 关联

- 不走 OpenSpec 提案流程（纯重构，行为零变更，决策见设计文档 §3 决策 3）
- 不关联 issue（无对应需求变更）
EOF
```

- [ ] **Step 3：等待 CI 全绿**

Run: `gh pr checks --watch`
Expected: CI 全绿（CI 不应新增失败，因为是纯重构 + 行为零变更）。

- [ ] **Step 4：转 PR 为 ready**

```bash
gh pr ready
```

---

## 自审完成情况

| 检查项 | 结果 |
|--------|------|
| Spec 覆盖：设计文档 §1-§11 的所有要求 | ✅ 每个范围项有对应 Task；§4 函数归属在 Task 1-4 Step 1-2；§5 测试拆分在 Task 7；§7 迁移步骤映射到 Task 1-7；§8 验证清单映射到 Task 8 + Task 6 Step 3 + Task 7 Step 8 |
| 占位符扫描（TBD / TODO / "implement later"） | ✅ 无 |
| 类型一致性：Task 间函数名 / 签名一致 | ✅ Task 1-4 引用的 44 个 export 函数名 + 行号与设计文档 §4 完全一致；Task 7 引用的测试名 + 行号与 Step 1 表格一致 |
| "Similar to Task N" 避免 | ✅ 每个 Task 包含完整的 imports + 函数列表 + 行号；Task 7 列出所有 17 个测试的归属，避免"类似处理"模糊 |
| 步骤可独立执行 | ✅ 每个 Task Step 给出可执行的命令（`deno check` / `deno fmt` / `deno task test` / `git commit`）与期望输出 |

## 执行交接

计划完成并保存到 `docs/superpowers/plans/2026-08-09-community-service-split.md`。两种执行选项：

**1. Subagent-Driven（推荐）** - 我为每个 Task 派遣独立的子代理，Task 之间人工 review，快速迭代

**2. Inline Execution** - 在当前会话中按 Task 执行批量，含 checkpoint 供 review

请选择执行方式。