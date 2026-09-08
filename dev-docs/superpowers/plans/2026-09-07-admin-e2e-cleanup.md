# Admin E2E 与清理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成管理员 UI 重做的收尾验证与清理，确保所有 plan/spec 项目可交付。

**Architecture:** 基于已完成的子域迁移、组件库与页面迁移，补充 E2E 冲突验证、文档与最终检查。

**Tech Stack:** Deno、Nuxt、jujutsu

**Spec:** `dev-docs/superpowers/specs/2026-09-07-admin-ui-redesign-design.md`

## Global Constraints

- 所有改动只发生在当前 worktree 内。
- 提交使用 jj + GPG 签名。
- 测试/检查必须通过 `deno task`。

---

### Task 1: E2E 冲突验证

**Files:**
- `noj-tests/e2e/19_admin_endpoints.test.ts`

**已完成：** 已添加 `4.3 乐观锁冲突返回 409` 测试，使用 `If-Match` 过期版本验证 `409 VERSION_CONFLICT`。

**Steps:**
- [x] **Step 1:** 确认测试文件 `deno check` 通过。
- [x] **Step 2:** 如 E2E 环境可用则运行 `deno task test`；不可用则记录为待 CI 验证。
  - 当前环境无 Redis/完整 E2E 依赖，已记录为待 CI 验证。

### Task 2: 全量检查

**Steps:**
- [x] **Step 1:** `cd noj-core && deno task check`
- [x] **Step 2:** `cd noj-ui && deno task check`
- [x] **Step 3:** `cd noj-tests && deno check e2e/19_admin_endpoints.test.ts`

### Task 3: 文档收尾

**Files:**
- `dev-docs/superpowers/specs/2026-09-07-admin-ui-redesign-design.md`
- `noj-core/CLAUDE.md`
- `noj-ui/AGENTS.md`

**Steps:**
- [x] **Step 1:** 确认设计文档签名已更新为 `adminAudit(action, detail, target?)` 与 `withAudit(meta)(handler)`。
- [x] **Step 2:** 确认 noj-core/noj-ui 文档包含 `domains/admin` 与统一管理组件清单。
- [x] **Step 3:** 提交：`docs(root): 管理员 UI 重做收尾文档`

---

## Self-Review

- **Spec coverage:** 覆盖设计第 10 节测试要求与文档。
- **Placeholder scan:** 无 TBD。
- **Type consistency:** E2E 使用新 subdomain 路径。
