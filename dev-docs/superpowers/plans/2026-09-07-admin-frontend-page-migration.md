# Admin 前端页面迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将所有 `/admin/*` 页面切换到新 subdomain API 路径，并逐步接入统一管理组件。

**Architecture:** 先在 `noj-ui` 与 `noj-tests` 中机械替换旧 `/api/v1/admin/*` 路径为新的 `/api/v1/admin/{subdomain}/*`；再按页面接入 `AdminPageHeader`/`AdminTable` 等组件。

**Tech Stack:** Nuxt 4、Vue 3、Nuxt UI v4、TypeScript

**Spec:** `dev-docs/superpowers/specs/2026-09-07-admin-ui-redesign-design.md`

## Global Constraints

- 通用组件使用 Nuxt UI v4 + Tailwind。
- 中文注释/文案，英文标识符。
- 所有改动只发生在当前 worktree 内。
- 提交使用 jj + GPG 签名。

---

### Task 1: 机械替换 noj-ui 旧 admin API 路径

**Files:**
- `noj-ui/pages/admin/**/*.vue`
- `noj-ui/components/admin/**/*.vue`
- `noj-ui/composables/**/*.ts`

**Replacements:**

| 旧 | 新 |
|---|---|
| `/api/v1/admin/users` | `/api/v1/admin/identity/users` |
| `/api/v1/admin/users/` | `/api/v1/admin/identity/users/` |
| `/api/v1/admin/roles` | `/api/v1/admin/identity/roles` |
| `/api/v1/admin/roles/` | `/api/v1/admin/identity/roles/` |
| `/api/v1/admin/permissions` | `/api/v1/admin/identity/permissions` |
| `/api/v1/admin/blacklist` | `/api/v1/admin/identity/blacklist` |
| `/api/v1/admin/blacklist/` | `/api/v1/admin/identity/blacklist/` |
| `/api/v1/admin/problems` | `/api/v1/admin/catalog/problems` |
| `/api/v1/admin/problems/` | `/api/v1/admin/catalog/problems/` |
| `/api/v1/admin/trainings` | `/api/v1/admin/catalog/trainings` |
| `/api/v1/admin/trainings/` | `/api/v1/admin/catalog/trainings/` |
| `/api/v1/admin/contests` | `/api/v1/admin/contest/contests` |
| `/api/v1/admin/contests/` | `/api/v1/admin/contest/contests/` |
| `/api/v1/admin/settings` | `/api/v1/admin/system/settings` |
| `/api/v1/admin/settings/` | `/api/v1/admin/system/settings/` |
| `/api/v1/admin/announcements` | `/api/v1/admin/system/announcements` |
| `/api/v1/admin/announcements/` | `/api/v1/admin/system/announcements/` |
| `/api/v1/admin/audit-logs` | `/api/v1/admin/system/audit-logs` |
| `/api/v1/admin/judge-images` | `/api/v1/admin/system/judge-images` |
| `/api/v1/admin/judge-images/` | `/api/v1/admin/system/judge-images/` |
| `/api/v1/admin/email-delivery` | `/api/v1/admin/system/email-delivery` |
| `/api/v1/admin/submissions` | `/api/v1/admin/submission/submissions` |
| `/api/v1/admin/submissions/` | `/api/v1/admin/submission/submissions/` |
| `/api/v1/admin/queue` | `/api/v1/admin/submission/queue` |
| `/api/v1/admin/queue/` | `/api/v1/admin/submission/queue/` |
| `/api/v1/admin/llm/` | `/api/v1/admin/gateway/llm/` |
| `/api/v1/admin/dashboard` | `/api/v1/admin/query/dashboard` |
| `/api/v1/community/admin` | `/api/v1/admin/community` |

**Steps:**
- [ ] **Step 1:** 对上述文件批量替换。
- [ ] **Step 2:** `deno task fmt` + `deno task lint`。
- [ ] **Step 3:** 提交：`refactor(ui): 管理页 API 路径切换到 admin 子域`

### Task 2: 机械替换 noj-tests 旧 admin API 路径

**Files:**
- `noj-tests/**/*.ts`

**Replacements:** 同 Task 1 映射。

**Steps:**
- [ ] **Step 1:** 批量替换。
- [ ] **Step 2:** 运行相关测试。
- [ ] **Step 3:** 提交：`refactor(test): 管理 E2E 路径切换到 admin 子域`

### Task 3: 审计日志页接入统一组件

**Files:**
- `noj-ui/pages/admin/audit-logs.vue`

**Steps:**
- [ ] **Step 1:** 使用 `AdminPageHeader` 替换手写页头。
- [ ] **Step 2:** 使用 `AdminFilterBar` 替换筛选条。
- [ ] **Step 3:** 使用 `AdminTable` 替换手写表格。
- [ ] **Step 4:** 提交：`feat(ui): 审计日志页接入统一组件`

### Task 4: 用户管理页接入统一组件

**Files:**
- `noj-ui/pages/admin/users.vue`

**Steps:**
- [ ] **Step 1:** 接入 `AdminPageHeader`、`AdminFilterBar`、`AdminTable`。
- [ ] **Step 2:** 保持现有角色/封禁弹窗逻辑。
- [ ] **Step 3:** 提交：`feat(ui): 用户管理页接入统一组件`

### Task 5: 其余管理页按需接入统一组件

**Files:**
- 剩余 `/admin/*` 页面

**Steps:**
- [ ] **Step 1:** 逐页接入 `AdminPageHeader`/`AdminTable`（至少页头与表格）。
- [ ] **Step 2:** 提交：`feat(ui): 其余管理页接入统一组件`

---

## Self-Review

- **Spec coverage:** 覆盖设计第 7 节的信息架构与第 8 节交互的 API 基础。
- **Placeholder scan:** 每个任务有明确文件与替换映射。
- **Type consistency:** API 路径与后端 sub domain 一致。
