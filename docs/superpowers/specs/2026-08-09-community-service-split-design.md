# community 服务层拆分设计

> **状态**：设计中（待用户复核）
> **目标文件**：`noj-core/src/services/community.ts`（1582 行 / 44 个导出 / 0 内部 type）
> **设计日期**：2026-08-09

## 1. 背景与动机

`noj-core/src/services/community.ts` 是项目内**唯一一个超过 1000 行的服务文件**，是次大文件（`users.ts` 665 行）的 **2.4 倍**，中位数服务文件（≈380 行）的 **4 倍**。

### 1.1 现状指标

| 指标 | 值 |
|------|---|
| 行数 | 1582 |
| 导出函数 | 44 |
| 内部 `interface` / `type` | 0（全部由 `types/community.ts` 提供） |
| 私有 helper | 9 |
| consumer 文件 | 5（`routes/community.ts` 主用；`routes/{conversations,contests,search}.ts` 各 1 个 import；2 个测试文件） |
| OpenSpec 主规范 | 已按 5 子域拆分：`community-configuration` / `community-content` / `community-moderation` / `community-social-feed` / `community-ui` |

### 1.2 拆分收益

- 与 OpenSpec 主规范的 5 子域一一对应，弥合规范-实现错位
- 显著降低合并冲突率（社区模块有 8 个自然子域，多人并发贡献常见）
- 加速 code review（文件 < 300 行后 reviewer 可"以文件为单位"评审）
- 与既有项目惯例一致：`problems-{list,crud,bundle}.ts`（3 文件）、`submissions-{crud,rejudge}.ts`（2 文件）、`community-seed.ts`（已作为兄弟文件独立，32 行）

## 2. 范围

### 2.1 在范围内

- 拆分 `noj-core/src/services/community.ts` 为 5 个子域文件
- 拆分 `noj-core/tests/services/community.test.ts` 为对应的子域测试文件
- `community.ts` 改为纯 re-export barrel

### 2.2 不在范围内

- `noj-core/src/routes/community.ts` 拆分（已在后续讨论中标记为 P1，本提案不处理）
- `noj-core/src/types/community.ts` 修改（已独立 59 行，无需变动）
- `noj-core/src/services/community-seed.ts` 修改（已独立 32 行，无需变动）
- `db/schema.ts` 中 community 相关表定义修改（无变动）
- OpenSpec 主规范修改（行为零变更，规范层面已是子域化）
- 公开 API 签名变更（44 个导出函数逐字搬运）
- 私有 helper 签名变更（9 个 helper 逐字搬运）

## 3. 决策

### 决策 1 — 拆分粒度：5 文件，对齐 OpenSpec 子域

| 新文件 | 对应 OpenSpec | 预估行数 |
|--------|--------------|---------:|
| `community-config.ts` | `community-configuration` | ≈ 240 |
| `community-content.ts` | `community-content` | ≈ 660 |
| `community-social-feed.ts` | `community-social-feed` | ≈ 240 |
| `community-moderation.ts` | `community-moderation` | ≈ 260 |
| `community-helpers.ts` | （跨子域保留位） | ≈ 15-30 |
| `community.ts` | — | ≈ 8（barrel） |
| `community-seed.ts` | （已存在，保留） | 32 |

### 决策 2 — `community.ts` 保留为纯 re-export barrel

```ts
// community.ts — re-export barrel for backward compatibility.
// 实际实现已拆分到子域文件，新代码请直接 import 子域文件：
//   import { createPost } from "./community-content.ts";
export * from "./community-config.ts";
export * from "./community-content.ts";
export * from "./community-social-feed.ts";
export * from "./community-moderation.ts";
```

现有 5 个 consumer 文件的 `import { ... } from "../services/community.ts"` 路径**零修改**。

### 决策 3 — 不走 OpenSpec 提案流程

纯重构，行为零变更，CI 测试覆盖保证回归；不创建 `openspec/changes/<date>-community-service-split/` 提案。该提案仅在本仓库 `docs/superpowers/specs/` 留存设计文档。

### 决策 4 — `community-helpers.ts` 保留为占位文件

经核对，没有真正跨子域的 helper 需要独立文件——所有 9 个私有 helper 都归属明确：

| Helper | 归属 |
|--------|------|
| `settingBoolean(key)` `settingNumber(key)` `featureForType(type)` `ensureSolutionAccepted()` | `community-config.ts` |
| `publicationStatus()` `canPostToBoard()` `toggleRelation()` | `community-content.ts` |
| `parseFeedCursor()` | `community-social-feed.ts` |
| `createNotification()` | `community-moderation.ts` |

`community-helpers.ts` 文件仍创建，作为社区级共享常量（如 `DEFAULT_FEED_PAGE_SIZE`、`NOTIFICATION_DEFAULT_LIMIT` 等）的归属；目前内容仅含文件头注释与可能的占位常量。后续跨子域 helper 新增时直接落入此文件。

## 4. 函数归属表

### 4.1 `community-config.ts`

对应 OpenSpec `community-configuration`，含 boards + 资格校验 + 配置读取：

| 内容 | 类型 | 起始行 |
|------|------|------:|
| `getCommunityConfig()` | export | 65 |
| `assertCommunityEnabled()` | export | 93 |
| `assertCommunityWritable()` | export | 100 |
| `resolveProblemId()` | export | 150 |
| `hasAcceptedSolution()` | export | 202 |
| `listBoards()` | export | 220 |
| `createBoard()` | export | 227 |
| `updateBoard()` | export | 251 |
| `listBoardRoleGrants()` | export | 271 |
| `updateBoardRoleGrant()` | export | 278 |
| `deleteBoardRoleGrant()` | export | 304 |
| `settingBoolean(key)` | private | 56 |
| `settingNumber(key)` | private | 60 |
| `featureForType(type)` | private | 123 |
| `ensureSolutionAccepted()` | private | 188 |

### 4.2 `community-content.ts`

对应 OpenSpec `community-content`，含 posts / comments / 互动（likes / bookmarks / follows）：

| 内容 | 类型 | 起始行 |
|------|------|------:|
| `createPost()` | export | 327 |
| `getPost()` | export | 419 |
| `listPosts()` | export | 462 |
| `countPostsByType()` | export | 547 |
| `listBookmarks()` | export | 578 |
| `updatePost()` | export | 617 |
| `changePostStatus()` | export | 653 |
| `togglePostFlag()` | export | 773 |
| `createComment()` | export | 807 |
| `listComments()` | export | 866 |
| `listPendingComments()` | export | 901 |
| `updateComment()` | export | 920 |
| `deleteComment()` | export | 950 |
| `changeCommentStatus()` | export | 703 |
| `togglePostLike()` | export | 1009 |
| `toggleBookmark()` | export | 1030 |
| `toggleCommentLike()` | export | 1037 |
| `toggleFollow()` | export | 1084 |
| `publicationStatus()` | private | 131 |
| `canPostToBoard()` | private | 312 |
| `toggleRelation()` | private | 986 |

### 4.3 `community-social-feed.ts`

对应 OpenSpec `community-social-feed`：

| 内容 | 类型 | 起始行 |
|------|------|------:|
| `updateActivityVisibility()` | export | 1114 |
| `createActivity()` | export | 1130 |
| `listFeed()` | export | 1150 |
| `parseFeedCursor()` | private | 1278 |

### 4.4 `community-moderation.ts`

对应 OpenSpec `community-moderation`，含审核 / 处罚 / 通知：

| 内容 | 类型 | 起始行 |
|------|------|------:|
| `listNotifications()` | export | 1315 |
| `getNotificationUnreadCount()` | export | 1327 |
| `markNotificationsRead()` | export | 1339 |
| `markNotificationRead()` | export | 1349 |
| `createReport()` | export | 1368 |
| `listReports()` | export | 1425 |
| `resolveReport()` | export | 1431 |
| `createSanction()` | export | 1453 |
| `revokeSanction()` | export | 1482 |
| `listSanctions()` | export | 1496 |
| `listUserSanctions()` | export | 1503 |
| `applyCommunityPreset()` | export | 1560 |
| `createNotification()` | private | 1284 |

### 4.5 `community-helpers.ts`

| 内容 | 类型 |
|------|------|
| 文件头注释 | — |
| （未来跨子域 helper 占位） | — |

### 4.6 `community.ts`（barrel）

```ts
export * from "./community-config.ts";
export * from "./community-content.ts";
export * from "./community-social-feed.ts";
export * from "./community-moderation.ts";
```

## 5. 测试拆分

`noj-core/tests/services/community.test.ts` 跟随服务文件按子域拆为：

| 新测试文件 | 覆盖范围 | 预估行数 |
|-----------|---------|---------:|
| `tests/services/community-config.test.ts` | config / eligibility / 矩阵配置 | ≈ 50 |
| `tests/services/community-content.test.ts` | posts / comments / likes / bookmarks / follows | ≈ 180 |
| `tests/services/community-social-feed.test.ts` | activity / feed / cursor 解析 | ≈ 50 |
| `tests/services/community-moderation.test.ts` | reports / sanctions / notifications / preset | ≈ 60 |

`tests/services/community-helpers.test.ts` 仅在 `community-helpers.ts` 有非空导出时新增。

`tests/routes/community.test.ts` 与 `tests/routes/search.test.ts` **零修改**——它们的 import 路径仍走 `community.ts` barrel，透明生效。

测试数量**严格守恒**（拆分前后的测试数 + 断言数应保持一致；不允许新增或删除任何测试用例）。

## 6. 不变量

| 不变量 | 保证机制 |
|--------|---------|
| 公开 API 签名零变更 | 44 个导出函数逐字搬运，不改名 / 不改参 / 不改返回 |
| 私有 helper 签名零变更 | 9 个 helper 逐字搬运 |
| 现有 5 个 consumer 零修改 | barrel re-export 维持导入路径兼容 |
| 数据库 schema 零变更 | 不触 `db/schema.ts` 与 `db/schema-ddl.ts` |
| 审计日志语义零变更 | `logAudit` 调用位置与 action 名不变 |
| SSE 广播零变更 | `publishEvent(Channels.*, ...)` 调用位置不变 |
| OpenSpec 主规范零变更 | 行为不变，规范层面已是子域化 |
| 测试覆盖零回归 | 拆分前后用例数 + 断言数守恒 |

## 7. 迁移步骤（执行顺序）

每步独立验证（`deno fmt && deno lint && deno task test` 全绿后方可进入下一步）：

1. **新增** `noj-core/src/services/community-content.ts`（最大、最易独立验证的子域）
2. **新增** `noj-core/src/services/community-config.ts`
3. **新增** `noj-core/src/services/community-social-feed.ts`
4. **新增** `noj-core/src/services/community-moderation.ts`
5. **新增** `noj-core/src/services/community-helpers.ts`（占位 + 文件头注释）
6. **改写** `noj-core/src/services/community.ts` 为 re-export barrel（≈ 8 行）
7. **拆分测试**：`tests/services/community.test.ts` 按 §5 拆为 4-5 个新测试文件
8. **删除** 原 `tests/services/community.test.ts`（内容已搬迁）

## 8. 验证清单

- [ ] `deno fmt` 无 diff
- [ ] `deno lint` 无警告（211 文件）
- [ ] `deno task test` 全量通过（测试数 + 断言数守恒）
- [ ] `deno check --no-check=false` 无类型错误
- [ ] 5 个 consumer 文件 import 路径零修改（`grep` 验证 `from ".*services/community\.ts"` 命中不变）
- [ ] `git diff --stat noj-core/src/services/community*.ts` 仅含新增 + 原文件缩为 barrel
- [ ] `git diff --stat openspec/` 零行（OpenSpec 主规范未触）
- [ ] GPG 签名可用（提交前 `gpg --list-secret-keys` 验证）
- [ ] commit message：`refactor(core): 拆分 community 服务为子域文件（与 OpenSpec 子域对齐）`（中文 Conventional Commits）

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 跨子域私有 helper 误归属导致编译失败 | §4 表格逐一标注每个 helper 的归属；执行步骤 1-5 后立即 `deno check` 验证类型 |
| barrel re-export 引入循环引用 | Drizzle table 全部来自 `db/schema.ts`，子域文件之间不互相 import；仅 barrel re-export 子域文件，单向依赖 |
| 测试用例在拆分中遗漏 | 拆分前后用 `grep -c "Deno.test\|test("` 与断言计数对比；要求数量守恒 |
| `community-helpers.ts` 空文件被 lint 报"无导出" | 添加 `export {};` 或仅含文件头注释 + 1 个占位 export 常量 |
| 既有 consumer 期望 import 顺序变化 | barrel re-export 不改变符号顺序；consumer 不感知 |

## 10. 不在本文档范围的后续工作

- `noj-core/src/routes/community.ts` 拆分（按 public / interactions / admin 拆为 3 个 router）— 标记为 P1，单独 PR
- `noj-core/src/routes/admin.ts` 拆分（按 8+ 子资源拆 router）— 标记为 P1，需 design 决策

## 11. 参考

- 项目知识库：`/home/user/neuro-oj/CLAUDE.md` §1.1（noj-core 职责）、§7.2（Conventional Commits）、§10（OpenSpec）、§12.1（测试）
- 拆分先例：`noj-core/src/services/problems-{list,crud,bundle}.ts`、`submissions-{crud,rejudge}.ts`
- OpenSpec 主规范：`openspec/specs/community-{configuration,content,moderation,social-feed,ui}/spec.md`
- 关联归档：`openspec/changes/archive/2026-07-31-add-community-system/`