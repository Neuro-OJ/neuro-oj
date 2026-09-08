# Admin 后端子域迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有分散在各业务域的管理员路由迁入 `domains/admin` 统一域，按 sub domain 组织新 API 路径，并为写操作接入审计/乐观锁基础。

**Architecture:** 在 `domains/admin/routes/` 下按 sub domain 新建路由文件，`domains/admin/index.ts` 统一挂载 `/identity`、`/catalog`、`/contest`、`/system`、`/community`、`/gateway`、`/submission`、`/query`；删除各业务域旧 admin 路由，保留公开路由。

**Tech Stack:** Deno 2、Hono、Drizzle ORM、postgres.js、Deno test

**Spec:** `dev-docs/superpowers/specs/2026-09-07-admin-ui-redesign-design.md`

## Global Constraints

- 所有代码标识符使用英文，注释/提交信息使用中文。
- 禁止修改 `_journal.json`；迁移只能通过 `deno task db:generate` 追加。
- 禁止手动修改 `deno.lock`。
- 测试必须通过 `deno task` 运行，不要直接手拼 `deno test`。
- 搜索代码使用 `rg`，不要使用 `grep`。
- 提交必须使用 jj 且带 GPG 签名。
- 所有改动必须只发生在当前 worktree 内，不得改动主仓库代码。

---

### Task 1: 迁移 identity 管理路由

**Files:**
- Create: `noj-core/src/domains/admin/routes/identity.ts`
- Modify: `noj-core/src/domains/admin/index.ts`
- Modify: `noj-core/src/domains/identity/routes/index.ts`
- Delete: `noj-core/src/domains/identity/routes/admin-users.ts`
- Delete: `noj-core/src/domains/identity/routes/admin-roles.ts`
- Delete: `noj-core/src/domains/identity/routes/admin-blacklist.ts`
- Test: `noj-core/src/domains/identity/tests/routes/admin-users.test.ts`（移到新路径或改请求路径）
- Test: `noj-core/src/domains/identity/tests/routes/admin-blacklist.test.ts`

**Interfaces:**
- Consumes: `domains/admin/services/admin-audit.ts` 的 `withAudit`（写操作接入）。
- Produces: `identityAdminRouter`（新路径前缀 `/identity`，挂在 `domains/admin/index.ts`）。

**Route mapping（旧 → 新）：**

| 旧路径 | 新路径 |
|---|---|
| `GET /api/v1/admin/users` | `GET /api/v1/admin/identity/users` |
| `PUT /api/v1/admin/users/:id` | `PUT /api/v1/admin/identity/users/:id` |
| `PATCH /api/v1/admin/users/:id/role` | `PATCH /api/v1/admin/identity/users/:id/role` |
| `PATCH /api/v1/admin/users/:id/ban` | `PATCH /api/v1/admin/identity/users/:id/ban` |
| `PATCH /api/v1/admin/users/:id/unban` | `PATCH /api/v1/admin/identity/users/:id/unban` |
| `GET /api/v1/admin/users/:id/bans` | `GET /api/v1/admin/identity/users/:id/bans` |
| `DELETE /api/v1/admin/users/:id` | `DELETE /api/v1/admin/identity/users/:id` |
| `GET /api/v1/admin/roles` | `GET /api/v1/admin/identity/roles` |
| `POST /api/v1/admin/roles` | `POST /api/v1/admin/identity/roles` |
| `PUT /api/v1/admin/roles/:id` | `PUT /api/v1/admin/identity/roles/:id` |
| `DELETE /api/v1/admin/roles/:id` | `DELETE /api/v1/admin/identity/roles/:id` |
| `GET /api/v1/admin/permissions` | `GET /api/v1/admin/identity/permissions` |
| `GET /api/v1/admin/blacklist` | `GET /api/v1/admin/identity/blacklist` |
| `POST /api/v1/admin/blacklist` | `POST /api/v1/admin/identity/blacklist` |
| `DELETE /api/v1/admin/blacklist/:id` | `DELETE /api/v1/admin/identity/blacklist/:id` |

**Steps:**

- [x] **Step 1:** 新建 `routes/identity.ts`，把三个旧文件的路由合并到一个 Hono router，路径改为上述新路径（在 router 内直接写 `/users`、`/roles`、`/blacklist`，由 `domains/admin/index.ts` 以 `/identity` 前缀挂载）。
- [x] **Step 2:** 更新 `domains/admin/index.ts`：导入 `identityAdminRouter` 并 `router.route("/identity", identityAdminRouter)`。
- [x] **Step 3:** 更新 `domains/identity/routes/index.ts`：删除 `identityAdminRouter` 导出及其对三个旧文件的引用；保留 `identityRouter` 公开路由。
- [x] **Step 4:** 为写操作接入 `withAudit`（至少：role_change、ban、unban、users.delete、roles create/update/delete、blacklist create/delete）。使用 `domains/admin/services/admin-audit.ts`。
- [x] **Step 5:** 迁移/更新对应测试，将请求路径改为新路径。
- [x] **Step 6:** 运行 `JWT_SECRET=test-secret deno task test --filter "admin"` 或对应测试，确保通过。
- [x] **Step 7:** 删除旧 admin 路由文件。
- [x] **Step 8:** 提交：`refactor(core): 迁移 identity 管理路由到 admin 域`

---

### Task 2: 迁移 catalog 管理路由

**Files:**
- Create: `noj-core/src/domains/admin/routes/catalog.ts`
- Modify: `noj-core/src/domains/admin/index.ts`
- Modify: `noj-core/src/domains/catalog/routes/index.ts`
- Delete: `noj-core/src/domains/catalog/routes/admin-problems.ts`
- Delete: `noj-core/src/domains/catalog/routes/admin-trainings.ts`
- Test: `noj-core/src/domains/catalog/tests/routes/admin-problems.test.ts`
- Test: `noj-core/src/domains/catalog/tests/routes/admin-trainings.test.ts`

**Route mapping（旧 → 新）：**

| 旧路径 | 新路径 |
|---|---|
| `GET /api/v1/admin/problems` | `GET /api/v1/admin/catalog/problems` |
| `GET /api/v1/admin/problems/:id/preflight` | `GET /api/v1/admin/catalog/problems/:id/preflight` |
| `GET /api/v1/admin/problems/review` | `GET /api/v1/admin/catalog/problems/review` |
| `POST /api/v1/admin/problems/review` | `POST /api/v1/admin/catalog/problems/review` |
| `GET /api/v1/admin/trainings` | `GET /api/v1/admin/catalog/trainings` |
| `PATCH /api/v1/admin/trainings/:id` | `PATCH /api/v1/admin/catalog/trainings/:id` |
| `DELETE /api/v1/admin/trainings/:id` | `DELETE /api/v1/admin/catalog/trainings/:id` |

注意：`problems/review` 和 `trainings` 原有细粒度权限，迁移后必须在具体路由上保留 `requirePermission`（可用 `requirePermission("problem:...")` / `requirePermission("training:...")` 或原逻辑）。`domains/admin/index.ts` 的 `FINE_GRAINED_ADMIN_PREFIXES` 可删除，因为迁移后统一在子路由内声明权限。

**Steps:**

- [x] **Step 1:** 新建 `routes/catalog.ts`，合并 `admin-problems.ts` 与 `admin-trainings.ts`，路径改为 `/problems`、`/trainings` 前缀。
- [x] **Step 2:** 更新 `domains/admin/index.ts` 挂载 `/catalog`。
- [x] **Step 3:** 更新 `catalog/routes/index.ts` 删除 `catalogAdminRouter`。
- [x] **Step 4:** 为写操作接入 `withAudit`（至少：problems review、trainings update/delete）。
- [x] **Step 5:** 更新测试路径并运行。
- [x] **Step 6:** 删除旧文件并提交：`refactor(core): 迁移 catalog 管理路由到 admin 域`

---

### Task 3: 迁移 contest 管理路由

**Files:**
- Create: `noj-core/src/domains/admin/routes/contest.ts`
- Modify: `noj-core/src/domains/admin/index.ts`
- Modify: `noj-core/src/domains/contest/routes/index.ts`
- Delete: `noj-core/src/domains/contest/routes/admin-contests.ts`
- Test: `noj-core/src/domains/contest/tests/routes/admin-contests.test.ts`

**Route mapping（旧 → 新）：**

| 旧路径 | 新路径 |
|---|---|
| `GET /api/v1/admin/contests` | `GET /api/v1/admin/contest/contests` |
| `GET /api/v1/admin/contests/:id` | `GET /api/v1/admin/contest/contests/:id` |
| `POST /api/v1/admin/contests` | `POST /api/v1/admin/contest/contests` |
| `PUT /api/v1/admin/contests/:id` | `PUT /api/v1/admin/contest/contests/:id` |
| `DELETE /api/v1/admin/contests/:id` | `DELETE /api/v1/admin/contest/contests/:id` |
| 其余 contest 子资源 | 将 `/contests/...` 整体替换为 `/contest/contests/...` |

**Steps:**

- [x] **Step 1:** 新建 `routes/contest.ts`，复制 `admin-contests.ts` 并调整路径。
- [x] **Step 2:** 更新 `domains/admin/index.ts` 挂载 `/contest`。
- [x] **Step 3:** 更新 `contest/routes/index.ts` 删除 `contestAdminRouter`。
- [x] **Step 4:** 为写操作接入 `withAudit`（至少：contest create/update/delete、participants add/remove、kind change、reset-code、ranking-snapshot）。
- [x] **Step 5:** 更新测试路径并运行。
- [x] **Step 6:** 删除旧文件并提交：`refactor(core): 迁移 contest 管理路由到 admin 域`

---

### Task 4: 迁移 system 管理路由

**Files:**
- Create: `noj-core/src/domains/admin/routes/system.ts`
- Modify: `noj-core/src/domains/admin/index.ts`
- Modify: `noj-core/src/domains/system/routes/index.ts`
- Delete: `noj-core/src/domains/system/routes/admin-announcements.ts`
- Delete: `noj-core/src/domains/system/routes/admin-audit.ts`
- Delete: `noj-core/src/domains/system/routes/admin-email-delivery.ts`
- Delete: `noj-core/src/domains/system/routes/admin-judge-images.ts`
- Delete: `noj-core/src/domains/system/routes/admin-settings.ts`
- Test: 对应 system 管理测试改路径

**Route mapping（旧 → 新）：**

| 旧路径 | 新路径 |
|---|---|
| `GET /api/v1/admin/announcements` | `GET /api/v1/admin/system/announcements` |
| `POST /api/v1/admin/announcements` | `POST /api/v1/admin/system/announcements` |
| `PUT /api/v1/admin/announcements/:id` | `PUT /api/v1/admin/system/announcements/:id` |
| `DELETE /api/v1/admin/announcements/:id` | `DELETE /api/v1/admin/system/announcements/:id` |
| `GET /api/v1/admin/audit-logs` | `GET /api/v1/admin/system/audit-logs` |
| `GET /api/v1/admin/settings` | `GET /api/v1/admin/system/settings` |
| `PUT /api/v1/admin/settings/:key` | `PUT /api/v1/admin/system/settings/:key` |
| `DELETE /api/v1/admin/settings/:key` | `DELETE /api/v1/admin/system/settings/:key` |
| `GET /api/v1/admin/settings/email/status` | `GET /api/v1/admin/system/settings/email/status` |
| `POST /api/v1/admin/settings/email/test-send` | `POST /api/v1/admin/system/settings/email/test-send` |
| `GET /api/v1/admin/judge-images` | `GET /api/v1/admin/system/judge-images` |
| `POST /api/v1/admin/judge-images` | `POST /api/v1/admin/system/judge-images` |
| `PUT /api/v1/admin/judge-images/:id` | `PUT /api/v1/admin/system/judge-images/:id` |
| `DELETE /api/v1/admin/judge-images/:id` | `DELETE /api/v1/admin/system/judge-images/:id` |
| `GET /api/v1/admin/email-delivery/suppressions` | `GET /api/v1/admin/system/email-delivery/suppressions` |
| `POST /api/v1/admin/email-delivery/suppressions/:id/clear` | `POST /api/v1/admin/system/email-delivery/suppressions/:id/clear` |

注意：`announcements` 原为细粒度权限路由，迁移后保留原权限检查。`audit-logs` 为只读，不接 `withAudit`。审计查询新增 `GET /api/v1/admin/system/audit-logs/actions`（返回可用 action 列表）。

**Steps:**

- [x] **Step 1:** 新建 `routes/system.ts`，合并五个旧文件并调整路径。
- [x] **Step 2:** 更新 `domains/admin/index.ts` 挂载 `/system`。
- [x] **Step 3:** 更新 `system/routes/index.ts` 删除 `systemAdminRouter`。
- [x] **Step 4:** 为写操作接入 `withAudit`（至少：announcements create/update/delete、settings update/delete、judge-images create/update/delete、email-delivery clear）。
- [x] **Step 5:** 新增 `GET /audit-logs/actions`。
- [x] **Step 6:** 更新测试路径并运行。
- [x] **Step 7:** 删除旧文件并提交：`refactor(core): 迁移 system 管理路由到 admin 域`

---

### Task 5: 迁移 community 管理路由

**Files:**
- Create: `noj-core/src/domains/admin/routes/community.ts`
- Modify: `noj-core/src/domains/admin/index.ts`
- Modify: `noj-core/src/domains/community/routes/index.ts`
- Modify: `noj-core/src/domains/community/routes/community-admin.ts`（拆分后删除 admin 部分，或整文件迁移）
- Test: `noj-core/src/domains/community/tests/...`（如有 community admin 测试）

**Route mapping（旧 → 新）：**

旧路径均在 `/api/v1/community/admin/...`，新路径为 `/api/v1/admin/community/...`，路由内路径去掉 `/admin` 前缀。

| 旧路径 | 新路径 |
|---|---|
| `POST /api/v1/community/admin/preset/:preset` | `POST /api/v1/admin/community/preset/:preset` |
| `POST /api/v1/community/admin/boards` | `POST /api/v1/admin/community/boards` |
| `PATCH /api/v1/community/admin/boards/:boardId` | `PATCH /api/v1/admin/community/boards/:boardId` |
| `PUT /api/v1/community/admin/boards/:boardId/role-grants/:roleId` | `PUT /api/v1/admin/community/boards/:boardId/role-grants/:roleId` |
| `DELETE /api/v1/community/admin/boards/:boardId/role-grants/:roleId` | `DELETE /api/v1/admin/community/boards/:boardId/role-grants/:roleId` |
| `GET/POST /api/v1/community/admin/reports...` | `GET/POST /api/v1/admin/community/reports...` |
| `POST /api/v1/community/admin/posts/:postId/:status` | `POST /api/v1/admin/community/posts/:postId/:status` |
| `POST /api/v1/community/admin/comments/:commentId/:status` | `POST /api/v1/admin/community/comments/:commentId/:status` |
| `POST /api/v1/community/admin/sanctions` | `POST /api/v1/admin/community/sanctions` |
| `DELETE /api/v1/community/admin/sanctions/:sanctionId` | `DELETE /api/v1/admin/community/sanctions/:sanctionId` |
| `GET/POST /api/v1/community/admin/content-review...` | `GET/POST /api/v1/admin/community/content-review...` |

**Steps:**

- [x] **Step 1:** 新建 `routes/community.ts`，从 `community-admin.ts` 迁移 admin 路由，去掉 `/admin` 路径段。
- [x] **Step 2:** 更新 `domains/admin/index.ts` 挂载 `/community`。
- [x] **Step 3:** 更新 `community/routes/index.ts`，只保留公开 `communityRouter`，不再挂载 communityAdmin（或保留非 admin 部分）。
- [x] **Step 4:** 为写操作接入 `withAudit`（至少：preset、boards CRUD、reports resolve/dismiss/reopen、posts/comments moderation、sanctions create/revoke、content-review decision）。
- [x] **Step 5:** 更新测试路径并运行。
- [x] **Step 6:** 删除旧的 community admin 代码（若整文件迁移则删除 `community-admin.ts`）。
- [x] **Step 7:** 提交：`refactor(core): 迁移 community 管理路由到 admin 域`

---

### Task 6: 迁移 gateway 管理路由

**Files:**
- Create: `noj-core/src/domains/admin/routes/gateway.ts`
- Modify: `noj-core/src/domains/admin/index.ts`
- Modify: `noj-core/src/domains/gateway/routes/index.ts`
- Delete: `noj-core/src/domains/gateway/routes/admin-llm.ts`
- Test: 如有 gateway admin 测试则更新

**Route mapping（旧 → 新）：**

| 旧路径 | 新路径 |
|---|---|
| `GET /api/v1/admin/llm/providers` | `GET /api/v1/admin/gateway/llm/providers` |
| `POST /api/v1/admin/llm/providers` | `POST /api/v1/admin/gateway/llm/providers` |
| `PUT /api/v1/admin/llm/providers/:id` | `PUT /api/v1/admin/gateway/llm/providers/:id` |
| `GET /api/v1/admin/llm/usage` | `GET /api/v1/admin/gateway/llm/usage` |
| `GET /api/v1/admin/llm/quotas` | `GET /api/v1/admin/gateway/llm/quotas` |
| `POST /api/v1/admin/llm/quotas` | `POST /api/v1/admin/gateway/llm/quotas` |

**Steps:**

- [x] **Step 1:** 新建 `routes/gateway.ts`，迁移 `admin-llm.ts` 并调整路径。
- [x] **Step 2:** 更新 `domains/admin/index.ts` 挂载 `/gateway`。
- [x] **Step 3:** 更新 `gateway/routes/index.ts` 删除 `gatewayAdminRouter`。
- [x] **Step 4:** 为写操作接入 `withAudit`（至少：provider create/update、quota create）。
- [x] **Step 5:** 更新测试并运行。
- [x] **Step 6:** 删除旧文件并提交：`refactor(core): 迁移 gateway 管理路由到 admin 域`

---

### Task 7: 迁移 submission 管理路由

**Files:**
- Create: `noj-core/src/domains/admin/routes/submission.ts`
- Modify: `noj-core/src/domains/admin/index.ts`
- Modify: `noj-core/src/domains/submission/routes/index.ts`
- Delete: `noj-core/src/domains/submission/routes/admin-submissions.ts`
- Test: 如有 submission admin 测试则更新

**Route mapping（旧 → 新）：**

| 旧路径 | 新路径 |
|---|---|
| `GET /api/v1/admin/submissions` | `GET /api/v1/admin/submission/submissions` |
| `GET /api/v1/admin/submissions/:id` | `GET /api/v1/admin/submission/submissions/:id` |
| `DELETE /api/v1/admin/submissions/:id` | `DELETE /api/v1/admin/submission/submissions/:id` |
| `GET /api/v1/admin/queue/health` | `GET /api/v1/admin/submission/queue/health` |
| `DELETE /api/v1/admin/queue/submissions/:id` | `DELETE /api/v1/admin/submission/queue/submissions/:id` |
| `POST /api/v1/admin/submissions/:id/rejudge` | `POST /api/v1/admin/submission/submissions/:id/rejudge` |
| `POST /api/v1/admin/problems/:id/rejudge` | `POST /api/v1/admin/submission/problems/:id/rejudge` |

**Steps:**

- [x] **Step 1:** 新建 `routes/submission.ts`，迁移 `admin-submissions.ts` 并调整路径。
- [x] **Step 2:** 更新 `domains/admin/index.ts` 挂载 `/submission`。
- [x] **Step 3:** 更新 `submission/routes/index.ts` 删除 `submissionAdminRouter`。
- [x] **Step 4:** 为写操作接入 `withAudit`（至少：submission delete、queue remove、rejudge）。
- [x] **Step 5:** 更新测试并运行。
- [x] **Step 6:** 删除旧文件并提交：`refactor(core): 迁移 submission 管理路由到 admin 域`

---

### Task 8: 迁移 query 管理路由

**Files:**
- Create: `noj-core/src/domains/admin/routes/query.ts`
- Modify: `noj-core/src/domains/admin/index.ts`
- Modify: `noj-core/src/domains/query/routes/index.ts`
- Delete: `noj-core/src/domains/query/routes/admin-dashboard.ts`
- Test: 如有 query admin 测试则更新

**Route mapping（旧 → 新）：**

| 旧路径 | 新路径 |
|---|---|
| `GET /api/v1/admin/dashboard/stats` | `GET /api/v1/admin/query/dashboard/stats` |
| `GET /api/v1/admin/dashboard/observability` | `GET /api/v1/admin/query/dashboard/observability` |

**Steps:**

- [x] **Step 1:** 新建 `routes/query.ts`，迁移 `admin-dashboard.ts` 并调整路径。
- [x] **Step 2:** 更新 `domains/admin/index.ts` 挂载 `/query`。
- [x] **Step 3:** 更新 `query/routes/index.ts` 删除 `queryAdminRouter`。
- [x] **Step 4:** 这些是只读路由，不接 `withAudit`。
- [x] **Step 5:** 更新测试并运行。
- [x] **Step 6:** 删除旧文件并提交：`refactor(core): 迁移 query 管理路由到 admin 域`

---

### Task 9: 补齐乐观锁与缺失 updated_at

**Files:**
- Modify: `noj-core/src/shared/db/schema/identity.ts`（userBans 增加 `updated_at`）
- Modify: `noj-core/src/shared/db/schema/system.ts`（ipBans 增加 `updated_at`）
- Modify: `noj-core/src/shared/db/schema/community.ts`（communityReports、communitySanctions 增加 `updated_at`）
- Modify: 相关 service 的 insert/update 语句，写入 `updated_at`
- Migration: 运行 `deno task db:generate`
- Test: 相关路由测试

**Steps:**

- [x] **Step 1:** 在 schema 中为上述表增加 `updated_at`（`text("updated_at").notNull()`，写入时填 ISO 字符串）。
- [x] **Step 2:** 更新所有 `insert`/`update` 调用点，设置 `updated_at`。
- [x] **Step 3:** 运行 `deno task db:generate` 生成迁移；禁止手动改 `_journal.json`。
- [x] **Step 4:** 在对应 admin 写路由接入 `adminVersionMiddleware` / `assertVersion`，使用 `updated_at` 作为版本令牌。
- [x] **Step 5:** 运行相关测试。
- [x] **Step 6:** 提交：`feat(core): admin 乐观锁支持与缺失 updated_at 补列`

---

### Task 10: 清理旧 admin 路由与文档

**Files:**
- Modify: `noj-core/src/domains/*/routes/index.ts`（确认已无 `*AdminRouter` 导出）
- Modify: `noj-core/src/domains/admin/index.ts`（确认 `FINE_GRAINED_ADMIN_PREFIXES` 已删除或不再需要）
- Modify: `noj-core/CLAUDE.md`（更新 admin 域结构）
- Modify: `dev-docs/superpowers/specs/2026-09-07-admin-ui-redesign-design.md`（更新 `adminAudit` 签名等过期内容）
- Test: 全量 `deno task test:smoke` + 相关 admin 测试

**Steps:**

- [x] **Step 1:** `rg "AdminRouter|routes/admin" noj-core/src` 确认无残留引用。
- [x] **Step 2:** 删除 `domains/admin/index.ts` 中不再需要的 `FINE_GRAINED_ADMIN_PREFIXES` 逻辑（若各子路由已自行声明权限）。
- [x] **Step 3:** 更新 `noj-core/CLAUDE.md`，加入 `domains/admin` 章节。
- [x] **Step 4:** 更新设计文档中过期签名（`adminAudit(c, ...)` → `adminAudit(action, detail, target?)`，`assertVersion` 从 service 导入）。
- [x] **Step 5:** 运行 `cd noj-core && deno task test:smoke` 与相关测试。
- [x] **Step 6:** 提交：`chore(core): 清理旧 admin 路由并更新文档`

---

## Self-Review

- **Spec coverage:** 本计划覆盖 spec 第 1、2、4 节（admin 域结构、统一审计、乐观锁）；SSE 复用不涉及后端改动。
- **Placeholder scan:** 每个任务都有明确的文件路径、路由映射和提交信息；迁移代码以现有文件为源，不需从零发明。
- **Type consistency:** 使用 `domains/admin/services/admin-audit.ts` 的 `withAudit` 和 `admin-audit.ts` 注册表；乐观锁使用 `admin-version` 导出的 `adminVersionMiddleware`/`assertVersion`。
