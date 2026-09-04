# noj-core Step 3：contest 域试点迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 contest 域从旧 `routes/`、`services/` 迁入 `src/domains/contest/`，并通过域门面消除跨域深路径导入，成为后续域迁移的样板。

**Architecture:** 保持同进程、同库；建立 `src/domains/contest/{routes,services}`，同时为被依赖的 `submission`、`community`、`identity` 创建最小门面（index.ts）从遗留 service 转发。迁移后 `check-domains --baseline` 不得新增违规。

**Tech Stack:** Deno 2、Hono、TypeScript、`scripts/check-domains.ts`。

**Spec:** `dev-docs/superpowers/specs/2026-09-01-noj-core-domain-isolation-design.md`
**Foundation Plan:** `dev-docs/superpowers/plans/2026-09-01-noj-core-domain-isolation-foundation.md`

## Global Constraints

- 使用 `jj` 提交，每个 Task 一个 change。
- 所有提交 GPG 签名，提交信息中文 Conventional Commits。
- 迁移过程中不改变业务行为。
- `check-domains --baseline dev-docs/engineering/domain-violations-baseline.txt` 必须保持通过（不得新增违规）。

---

### Task 1: 创建 contest 域目录并搬移 services

**Files:**
- Move:
  - `noj-core/src/services/contest/contests.ts` → `noj-core/src/domains/contest/services/contests.ts`
  - `noj-core/src/services/contest/contest-ranking.ts` → `noj-core/src/domains/contest/services/contest-ranking.ts`
  - `noj-core/src/services/contest/contest-clarifications.ts` → `noj-core/src/domains/contest/services/contest-clarifications.ts`
- Modify: 上述三个文件内部的相对导入深度（从 `src/services/contest/` 迁到 `src/domains/contest/services/`，所有指向 `src/db`、`src/lib`、`src/types`、`src/services/<other>` 的相对路径需多加一层 `../`）。

**Interfaces:**
- Consumes: 现有 `src/db/schema.ts`、`src/lib/*`、`src/types/contests.ts`。
- Produces:
  - `src/domains/contest/services/contests.ts` 保持现有导出签名不变。
  - `src/domains/contest/services/contest-ranking.ts` 保持 `getKaggleRanking`、`getContestRanking` 导出不变。
  - `src/domains/contest/services/contest-clarifications.ts` 保持 `createClarification`、`replyToClarification`、`listClarifications` 导出不变。

- [ ] **Step 1: 创建目录并移动文件**

```bash
mkdir -p noj-core/src/domains/contest/services
mv noj-core/src/services/contest/contests.ts noj-core/src/domains/contest/services/contests.ts
mv noj-core/src/services/contest/contest-ranking.ts noj-core/src/domains/contest/services/contest-ranking.ts
mv noj-core/src/services/contest/contest-clarifications.ts noj-core/src/domains/contest/services/contest-clarifications.ts
```

- [ ] **Step 2: 调整 contest service 文件内的相对导入**

对三个文件执行机械式路径修正：

- `../../db/` → `../../../db/`
- `../../lib/` → `../../../lib/`
- `../../types/` → `../../../types/`
- `./contests.ts` 保持不变
- `../notifications.ts`（contest-clarifications.ts）→ 改为 `../../community/index.ts`（Task 2 创建门面后生效）

- [ ] **Step 3: 运行类型检查**

Run: `cd noj-core && deno check src/domains/contest/services/*.ts`
Expected: 仅有 `src/domains/community/index.ts` 缺失导致的报错（Task 2 修复）。

- [ ] **Step 4: 暂不提交，等 Task 2 完成后统一提交**

---

### Task 2: 为被依赖域创建最小门面

**Files:**
- Create:
  - `noj-core/src/domains/contest/index.ts`
  - `noj-core/src/domains/submission/index.ts`
  - `noj-core/src/domains/community/index.ts`
  - `noj-core/src/domains/identity/index.ts`

**Interfaces:**
- Consumes: 现有 legacy services。
- Produces:
  - `submission/index.ts` 导出 `createArtifactSubmission`、`createSubmission`、`listSubmissions`。
  - `community/index.ts` 导出 `createActivity`。
  - `identity/index.ts` 导出 `resolveUserId`。

- [ ] **Step 1: 创建 `src/domains/contest/index.ts`**

```ts
export {
  addParticipants,
  computeContestStatus,
  createContest,
  deleteContest,
  getContest,
  getContestProblems,
  isParticipant,
  listContests,
  listParticipants,
  registerForContest,
  removeParticipant,
  resolveContestId,
  updateContest,
} from "./services/contests.ts";
export {
  createClarification,
  listClarifications,
  replyToClarification,
} from "./services/contest-clarifications.ts";
export { getContestRanking } from "./services/contest-ranking.ts";
```

- [ ] **Step 2: 创建 `src/domains/submission/index.ts`**

```ts
export {
  createArtifactSubmission,
  createSubmission,
  listSubmissions,
} from "../../services/submissions/submissions.ts";
```

- [ ] **Step 3: 创建 `src/domains/community/index.ts`**

```ts
export { createActivity } from "../../services/community/community.ts";
```

- [ ] **Step 4: 创建 `src/domains/identity/index.ts`**

```ts
export { resolveUserId } from "../../services/users.ts";
```

- [ ] **Step 5: 运行类型检查**

Run: `cd noj-core && deno check src/domains/contest/services/*.ts`
Expected: PASS（contest 门面与三个外部门面补上缺失导入）。

---

### Task 3: 搬移 contest 路由并改接门面

**Files:**
- Move:
  - `noj-core/src/routes/contests.ts` → `noj-core/src/domains/contest/routes/contests.ts`
  - `noj-core/src/routes/admin/admin-contests.ts` → `noj-core/src/domains/contest/routes/admin-contests.ts`
- Modify:
  - `noj-core/src/domains/contest/routes/contests.ts`
  - `noj-core/src/domains/contest/routes/admin-contests.ts`
  - `noj-core/src/routes/admin/index.ts`
  - `noj-core/src/app.ts`

**Interfaces:**
- Consumes: Task 1/2 的 contest services 与三个门面。
- Produces: `app.ts` 从 `src/domains/contest/routes/contests.ts` 挂载 `/api/v1/contests`；admin 路由从 `src/domains/contest/routes/admin-contests.ts` 挂载。

- [ ] **Step 1: 创建目录并移动路由文件**

```bash
mkdir -p noj-core/src/domains/contest/routes
mv noj-core/src/routes/contests.ts noj-core/src/domains/contest/routes/contests.ts
mv noj-core/src/routes/admin/admin-contests.ts noj-core/src/domains/contest/routes/admin-contests.ts
```

- [ ] **Step 2: 调整 `contests.ts` 内部路径**

- `../middleware/` → `../../../middleware/`
- `../lib/` → `../../../lib/`
- `../types/` → `../../../types/`
- `../services/contest/` → `../services/`
- `../services/submissions/submissions.ts` → `../../submission/index.ts`
- `../services/community/community.ts` → `../../community/index.ts`

- [ ] **Step 3: 调整 `admin-contests.ts` 内部路径**

- `../../middleware/` → `../../../middleware/`
- `../../lib/` → `../../../lib/`
- `../../types/` → `../../../types/`
- `../../services/contest/` → `../services/`
- `../../services/submissions/submissions.ts` → `../../submission/index.ts`
- `../../services/users.ts` → `../../identity/index.ts`

- [ ] **Step 4: 更新 `src/routes/admin/index.ts`**

将：

```ts
import adminContests from "./admin-contests.ts";
```

改为：

```ts
import adminContests from "../../domains/contest/routes/admin-contests.ts";
```

- [ ] **Step 5: 更新 `src/app.ts`**

将：

```ts
import contests from "./routes/contests.ts";
```

改为：

```ts
import contests from "./domains/contest/routes/contests.ts";
```

- [ ] **Step 6: 运行类型检查**

Run: `cd noj-core && deno check src/app.ts`
Expected: PASS

---

### Task 4: 更新测试导入路径并验证

**Files:**
- Modify:
  - `noj-core/tests/services/contests.test.ts`
  - `noj-core/tests/services/contest-ranking.test.ts`
  - `noj-core/tests/services/contest-clarifications.test.ts`

**Interfaces:**
- Consumes: contest 域迁移后的文件路径。
- Produces: 测试仍然覆盖 contest 域服务。

- [ ] **Step 1: 将测试中的以下导入路径**

```ts
"../../src/services/contest/contests.ts"
"../../src/services/contest/contest-ranking.ts"
"../../src/services/contest/contest-clarifications.ts"
```

统一改为：

```ts
"../../src/domains/contest/services/contests.ts"
"../../src/domains/contest/services/contest-ranking.ts"
"../../src/domains/contest/services/contest-clarifications.ts"
```

- [ ] **Step 2: 运行 contest 相关测试**

Run: `cd noj-core && deno test -A --no-check tests/services/contests.test.ts tests/services/contest-ranking.test.ts tests/services/contest-clarifications.test.ts`
Expected: PASS

- [ ] **Step 3: 运行域边界检查（基线模式）**

Run: `deno run -A scripts/check-domains.ts --baseline dev-docs/engineering/domain-violations-baseline.txt`
Expected: `域边界检查通过（无新增违规）`

- [ ] **Step 4: 运行 `check-all`**

Run: `deno run -A scripts/check-all.ts`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
jj commit -m "refactor(core): contest 域迁移到 src/domains 并接入门面"
```

---

## 验收标准

1. `src/services/contest/` 不再存在（目录清空/删除）。
2. `src/domains/contest/` 包含 `routes/`、`services/`。
3. `src/domains/contest/**` 没有指向其他域 `services/` 深路径的导入。
4. `check-domains --baseline` 无新增违规。
5. `check-all` 全绿。
