# Admin 前端组件库实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立统一管理面板组件族与 composables，为全部 `/admin/*` 页面迁移提供基础。

**Architecture:** 在 `noj-ui/components/admin/` 下新增通用组件，在 `noj-ui/composables/` 下新增 `useAdminResource`/`useAdminForm`。组件基于 Nuxt UI v4 + Tailwind，沿用现有设计 token。

**Tech Stack:** Nuxt 4、Vue 3、Nuxt UI v4、Tailwind CSS v4、TypeScript

**Spec:** `dev-docs/superpowers/specs/2026-09-07-admin-ui-redesign-design.md`

## Global Constraints

- 通用组件必须使用 Nuxt UI v4（`U*` 组件），禁止手写通用组件。
- 样式使用 Tailwind utility，禁止写冗余 CSS。
- 中文注释/文案，英文标识符。
- 所有改动只发生在当前 worktree 内。
- 提交使用 jj + GPG 签名。

---

### Task 1: 新增 AdminPageHeader 与 AdminFilterBar

**Files:**
- Create: `noj-ui/components/admin/AdminPageHeader.vue`
- Create: `noj-ui/components/admin/AdminFilterBar.vue`

**Interfaces:**
- `AdminPageHeader` props: `title: string`, `description?: string`, `icon?: string`
- Slot: `actions`
- `AdminFilterBar` props: `modelValue?: Record<string, unknown>`
- Emits: `update:modelValue`, `search`, `reset`
- Slot: `default`（筛选字段）

**Steps:**
- [ ] **Step 1:** 实现 `AdminPageHeader.vue`（含面包屑占位、标题、描述、操作区）。
- [ ] **Step 2:** 实现 `AdminFilterBar.vue`（含默认筛选/重置按钮）。
- [ ] **Step 3:** `deno task lint` / `deno task fmt`。
- [ ] **Step 4:** 提交：`feat(ui): 新增 AdminPageHeader 与 AdminFilterBar`

### Task 2: 新增 AdminTable

**Files:**
- Create: `noj-ui/components/admin/AdminTable.vue`

**Interfaces:**
- Props:
  - `columns: AdminColumn[]`（`{ key: string; label: string; sortable?: boolean; width?: string }`）
  - `items: Record<string, unknown>[]`
  - `loading?: boolean`
  - `error?: string`
  - `totalPages?: number`
  - `currentPage?: number`
  - `rowKey?: string`（默认 `"id"`）
- Emits: `update:page`, `sort`, `row-click`
- Slots: `cell`（`#cell="{ row, column }"`）、`empty`、`actions`

**Steps:**
- [ ] **Step 1:** 基于 `UTable` 实现通用表格（分页、排序、空/错/加载态）。
- [ ] **Step 2:** 接入 `UPagination`。
- [ ] **Step 3:** 提交：`feat(ui): 新增 AdminTable`

### Task 3: 新增 AdminEditPanel 与 AdminFormField

**Files:**
- Create: `noj-ui/components/admin/AdminEditPanel.vue`
- Create: `noj-ui/components/admin/AdminFormField.vue`

**Interfaces:**
- `AdminFormField` props: `label: string`, `required?: boolean`, `error?: string`, `hint?: string`
- Slot: `default`
- `AdminEditPanel` props: `open: boolean`, `title: string`, `width?: string`, `version?: string`
- Emits: `close`, `save`, `conflict-refresh`, `conflict-discard`
- Slots: `default`（表单）、`footer`

**Steps:**
- [ ] **Step 1:** 实现 `AdminFormField.vue`（label/error/hint 包装）。
- [ ] **Step 2:** 实现 `AdminEditPanel.vue`（基于 `UModal`/`UDrawer`，展示版本号，冲突提示区）。
- [ ] **Step 3:** 提交：`feat(ui): 新增 AdminEditPanel 与 AdminFormField`

### Task 4: 新增 AdminConfirmDialog / AdminStatusBadge / AdminDetailDrawer

**Files:**
- Create: `noj-ui/components/admin/AdminConfirmDialog.vue`
- Create: `noj-ui/components/admin/AdminStatusBadge.vue`
- Create: `noj-ui/components/admin/AdminDetailDrawer.vue`

**Interfaces:**
- `AdminConfirmDialog` props: `open`, `title`, `message`, `confirmText?`, `danger?`
- `AdminStatusBadge` props: `status: string`, `label?: string`
- `AdminDetailDrawer` props: `open`, `title`, `items: { label: string; value: unknown }[]`

**Steps:**
- [ ] **Step 1:** 实现三个组件。
- [ ] **Step 2:** 提交：`feat(ui): 新增管理端通用对话框/状态徽标/详情抽屉`

### Task 5: 新增 useAdminResource 与 useAdminForm

**Files:**
- Create: `noj-ui/composables/useAdminResource.ts`
- Create: `noj-ui/composables/useAdminForm.ts`

**Interfaces:**
- `useAdminResource<T>(options)` 返回 `{ items, total, loading, error, page, perPage, load, setPage, search }`
- `useAdminForm<T>(initial, version?)` 返回 `{ draft, setDraft, reset, version, setVersion }`

**Steps:**
- [ ] **Step 1:** 实现 `useAdminResource`（复用 `useAdminList`，集成分页/搜索）。
- [ ] **Step 2:** 实现 `useAdminForm`（草稿/版本管理）。
- [ ] **Step 3:** 提交：`feat(ui): 新增 useAdminResource 与 useAdminForm`

---

## Self-Review

- **Spec coverage:** 覆盖设计第 6 节的组件体系与 composables。
- **Placeholder scan:** 每个任务有明确文件与接口。
- **Type consistency:** `AdminColumn`/`AdminTable` 等类型在任务间一致。
