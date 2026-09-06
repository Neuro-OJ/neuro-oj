# 竞赛防作弊修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 2026-09-05 审计整改：题目可见性（private/public）、竞赛分类（public/invite）、服务层统一访问解析与提交上下文强制、统一结果投影、评测公平与硬化，共 12 项 finding 修复（F-06/F-09/F-10 搁置）。

**Architecture:** 在 noj-core 引入两个横切纯函数（catalog 域 `resolveProblemAccess`、submission 域 `applySubmissionProjection`），所有读/提交路径强制复用；竞赛上下文由 contest 域 `verifyContestAccess` 校验后传入 resolver，保持域依赖单向（submission→catalog+contest，catalog 不依赖 contest）；judge 侧移除全局 Semaphore，改每用户并发上限 1。

**Tech Stack:** Deno 2 + Hono + Drizzle（noj-core）、Rust + Tokio + bollard（noj-judge）、Nuxt 4（noj-ui）、Deno（noj-tests e2e）、Redis（限额预算）。

**Spec:** [dev-docs/superpowers/specs/2026-09-05-contest-anti-cheat-fix-design.md](../specs/2026-09-05-contest-anti-cheat-fix-design.md)

## Global Constraints

- 提交：jj 工作流，每任务结束 `jj describe -m "<type>(<scope>): 中文描述"` 后 `jj new` 开始下一任务；type ∈ feat/fix/docs/refactor/test/chore，scope ∈ core/ui/judge/root；全部提交 GPG 签名（已配置 signing.backend=gpg）。
- 禁止直接推送 `main`；禁止手改 `drizzle/meta/_journal.json`、`deno.lock`、`Cargo.lock`。
- 新 Drizzle 迁移 SQL 不带 `public.` schema 前缀（分片测试约束）。
- noj-core 测试必须经 `deno task`（`deno task test:parallel` 优先；无 PG 用 `deno task test`）；禁止手拼 `deno test`。
- noj-judge：`cargo fmt` + `cargo clippy` 零警告；测试 `cargo nextest run --all-targets`；集成测试需 `NOJ_RUN_E2E=1` + Docker。
- 中文注释/文档/提交描述，英文标识符；错误用 `AppError` 体系（core）/ `anyhow::Result`（judge）。
- 非平凡变更在全部任务完成后新增 `.agents/notes/implemented/architecture/2026-09-05-contest-anti-cheat-fix.md` 并经 `deno run -A scripts/verify-agent-note-format.ts` 校验。
- 域间导入只经 `domains/<domain>/index.ts` 门面；`shared/` 不反向依赖 `domains/`。

## 文件结构总览

新增：

- `noj-core/src/domains/catalog/services/problem-access.ts` — `resolveProblemAccess` 纯函数（读/提交共用的题目访问判定）
- `noj-core/src/domains/submission/services/submissions/submission-projection.ts` — `applySubmissionProjection` 纯函数 + details 白名单
- `noj-core/src/domains/contest/services/contest-access.ts` — `verifyContestAccess`（成员+窗口校验，供 resolver 消费）
- `noj-tests/e2e/30_contest_anti_cheat.test.ts` — 攻击剧本 e2e
- 各域 `tests/` 对应测试文件

修改（核心）：

- `noj-core/src/shared/db/schema/catalog.ts`（problems.visibility）、`contest.ts`（contests.kind）
- `noj-core/src/domains/catalog/services/problems/problems-list.ts` / `problems-crud.ts` / `trainings.ts` / `support-package.ts`
- `noj-core/src/domains/submission/services/submissions/submissions-crud.ts` / `services/self-tests.ts` / `routes/submissions.ts` / `routes/queue.ts` / `services/queue.ts` / `mq/consumer.ts` / `mq/producer.ts` / `types/index.ts`
- `noj-core/src/domains/contest/services/contests.ts` / `routes/contests.ts` / `routes/sse.ts`
- `noj-core/src/domains/objective/services/objective-submissions.ts` / `objective-questions.ts`
- `noj-core/src/domains/identity/types/permissions.ts` / `domains/system/services/seed/seed-rbac.ts`
- `noj-core/src/domains/identity/routes/auth.ts`（F-12）
- `noj-judge/src/types.rs` / `main.rs` / `mq.rs` / `sandbox/download.rs` / `dual/mod.rs`
- `noj-ui/pages/admin/*.vue`、`noj-ui/pages/contests/[contestId]/index.vue`（后台与建赛向导）

## 任务依赖

```text
Task 1 (迁移) ──→ Task 2 (RBAC) ──→ Task 3 (resolver) ──┬─→ Task 4 (catalog 读路径)
Task 3 ────────────────────────────────────────────────┴─→ Task 6 (提交三入口)
Task 1 ──→ Task 7 (建赛加题校验 + kind 规则) ──→ Task 8 (F-04 限额) ──→ Task 9 (注册 kind + F-13)
Task 10 (投影函数) ──→ Task 11 (读路径接入) ──→ Task 12 (客观题) ──→ Task 13 (details 白名单)
Task 14 (F-07 judge) 依赖 Task 1 之后可并行；Task 15 (F-08) 独立
Task 16 (F-12) 独立；Task 17 (后台 UI) 依赖 Task 4/7/9；Task 18 (e2e) 依赖 4-13；Task 19 (文档) 收尾
```

---

### Task 1: 数据迁移——problems.visibility 与 contests.kind

**Files:**
- Modify: `noj-core/src/shared/db/schema/catalog.ts:21-76`（problems 表加 visibility）
- Modify: `noj-core/src/shared/db/schema/contest.ts:21-43`（contests 表加 kind）
- Create: `noj-core/drizzle/00XX_*.sql`（由 db:generate 生成，勿手写）
- Test: `noj-core/tests/00_migrate_test.ts`（已有，迁移自动执行）

**Interfaces:**
- Produces: `problems.visibility`（public|private，notNull default public）；`contests.kind`（public|invite，notNull default public）

- [x] **Step 1: 修改 catalog.ts schema**

在 problems 表 `is_objective` 之后加列，并在 constraints 数组追加 CHECK：

```ts
visibility: text("visibility").notNull().default("public"),
```

```ts
visibilityCheck: check(
  "problems_visibility_check",
  sql`${table.visibility} IN ('public', 'private')`,
),
```

- [x] **Step 2: 修改 contest.ts schema**

在 contests 表 `type` 之后加列，constraints 追加：

```ts
kind: text("kind").notNull().default("public"),
```

```ts
kindCheck: check(
  "contests_kind_check",
  sql`${table.kind} IN ('public', 'invite')`,
),
```

- [x] **Step 3: 生成迁移并检查**

Run: `cd noj-core && deno task db:generate`
Expected: 生成新 SQL；检查 SQL 内无 `public.` schema 前缀；`_journal.json` 自动更新（勿手改）。

- [x] **Step 4: 数据回填（迁移 SQL 末尾追加）**

```sql
UPDATE "contests" SET "kind" = CASE WHEN "is_public" THEN 'public' ELSE 'invite' END;
UPDATE "contests" SET "password" = encode(gen_random_bytes(12), 'hex')
  WHERE "kind" = 'invite' AND ("password" IS NULL OR "password" = '');
```

若历史迁移中无 `CREATE EXTENSION IF NOT EXISTS pgcrypto`（gen_random_bytes 所属），在本迁移头部补一行。

- [x] **Step 5: 运行迁移测试**

Run: `cd noj-core && deno task test:parallel`
Expected: 全绿；00_migrate_test 通过即迁移可执行。

- [x] **Step 6: 提交**

```bash
jj describe -m "feat(core): problems.visibility 与 contests.kind 迁移"
jj new
```

---

### Task 2: RBAC 新增 contest:create

**Files:**
- Modify: `noj-core/src/domains/identity/types/permissions.ts`
- Modify: `noj-core/src/domains/system/services/seed/seed-rbac.ts`
- Test: `noj-core/src/domains/identity/tests/services/rbac.test.ts`

**Interfaces:**
- Produces: 权限字符串 `contest:create`，默认角色（root/admin/default user）自动授予。

- [x] **Step 1: 写失败测试**

在 `rbac.test.ts` 追加（按现有测试文件的 fixture 命名调整 defaultUserId / hasDbEnv）：

```ts
Deno.test({
  name: "rbac: 默认角色具备 contest:create 权限",
  ignore: !hasDbEnv(),
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await ensureRbacSeeds();
    const perms = await getUserPermissions(defaultUserId);
    assert(perms.has("contest:create"), "默认角色应有 contest:create");
  },
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd noj-core && deno task test -- rbac.test.ts`
Expected: FAIL（权限定义不存在）。

- [x] **Step 3: 实现**

`PERMISSION_DEFS` 追加：

```ts
{ resource: "contest", action: "create", description: "创建邀请赛" },
```

`seed-rbac.ts`：把 `contest:create` 加入 default 角色（root/admin 按现有全量授予方式自动获得）。

- [x] **Step 4: 跑测试确认通过**
- [x] **Step 5: 提交**

```bash
jj describe -m "feat(core): RBAC 新增 contest:create 权限"
jj new
```

---

### Task 3: 统一访问解析器 resolveProblemAccess

**Files:**
- Create: `noj-core/src/domains/catalog/services/problem-access.ts`
- Create: `noj-core/src/domains/catalog/services/contest-access-info.ts`（轻量类型，避免 catalog 依赖 contest 域）
- Modify: `noj-core/src/domains/catalog/index.ts`（导出）
- Test: `noj-core/src/domains/catalog/tests/services/problem-access.test.ts`

**Interfaces:**
- Produces:

```ts
// contest-access-info.ts
export type ContestAccessInfo = {
  contestId: string;
  allowed: boolean;   // 成员 + 窗口（running 或 ended）通过
  running: boolean;   // 是否窗口内
};
```

```ts
// problem-access.ts
export type ProblemAccessResult = {
  allowed: boolean;
  mode: "admin" | "owner" | "contest" | "public" | "denied";
};

export function resolveProblemAccess(
  problem: { id: string; visibility: string; owner_id: string },
  ctx: { viewerId: string | null; isAdmin: boolean; contestAccess?: ContestAccessInfo | null },
): ProblemAccessResult;
```

- [x] **Step 1: 写失败测试（判定矩阵）**

`problem-access.test.ts` 覆盖矩阵（纯函数，无 DB）：

```ts
Deno.test("problem-access: 判定矩阵", () => {
  const priv = { id: "p1", visibility: "private", owner_id: "u-owner" };
  const pub = { id: "p2", visibility: "public", owner_id: "u-owner" };
  assertEquals(resolveProblemAccess(priv, { viewerId: "u-x", isAdmin: true }).mode, "admin");
  assertEquals(resolveProblemAccess(priv, { viewerId: "u-owner", isAdmin: false }).mode, "owner");
  assertEquals(resolveProblemAccess(priv, { viewerId: "u-x", isAdmin: false }).mode, "denied");
  assertEquals(resolveProblemAccess(pub, { viewerId: null, isAdmin: false }).mode, "public");
  assertEquals(resolveProblemAccess(priv, { viewerId: "u-x", isAdmin: false,
    contestAccess: { contestId: "c1", allowed: true, running: true } }).mode, "contest");
  assertEquals(resolveProblemAccess(pub, { viewerId: "u-x", isAdmin: false,
    contestAccess: { contestId: "c1", allowed: false, running: true } }).mode, "denied");
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd noj-core && deno task test -- problem-access.test.ts`
Expected: FAIL（模块不存在）。

- [x] **Step 3: 实现 resolver**

```ts
import type { ContestAccessInfo } from "./contest-access-info.ts";

export type { ContestAccessInfo };
export type ProblemAccessResult = {
  allowed: boolean;
  mode: "admin" | "owner" | "contest" | "public" | "denied";
};

export function resolveProblemAccess(
  problem: { id: string; visibility: string; owner_id: string },
  ctx: { viewerId: string | null; isAdmin: boolean; contestAccess?: ContestAccessInfo | null },
): ProblemAccessResult {
  if (ctx.isAdmin) return { allowed: true, mode: "admin" };
  if (ctx.viewerId !== null && ctx.viewerId === problem.owner_id) {
    return { allowed: true, mode: "owner" };
  }
  if (ctx.contestAccess) {
    // 携带竞赛上下文：只认上下文判定，不回退 public（防伪造 context）
    return ctx.contestAccess.allowed
      ? { allowed: true, mode: "contest" }
      : { allowed: false, mode: "denied" };
  }
  return problem.visibility === "public"
    ? { allowed: true, mode: "public" }
    : { allowed: false, mode: "denied" };
}
```

- [x] **Step 4: 跑测试确认通过**
- [x] **Step 5: 门面导出并提交**

`catalog/index.ts` 追加 `export * from "./services/problem-access.ts";` 与 `contest-access-info.ts`。

```bash
jj describe -m "feat(core): 统一题目访问解析器 resolveProblemAccess"
jj new
```

---

### Task 4: catalog 读路径接入 resolver（详情/列表/搜索/题单/套卷/删除保护）

**Files:**
- Modify: `noj-core/src/domains/catalog/routes/problems.ts`（GET /:id、GET /:id/questions）
- Modify: `noj-core/src/domains/catalog/services/problems/problems-list.ts`（toProblemResponse 分级、列表过滤）
- Modify: `noj-core/src/domains/query/services/search.ts`（visibility 过滤）
- Modify: `noj-core/src/domains/catalog/services/trainings.ts`（题单题目列表逐题过滤）
- Test: `noj-core/src/domains/catalog/tests/routes/problems.test.ts`

**Interfaces:**
- Consumes: `resolveProblemAccess`（Task 3）；contest 读题路径的上下文接入由 Task 11 回填（本任务先覆盖无上下文路径）。
- Produces: `toProblemResponse` 新参数 `viewer: { isOwnerOrAdmin: boolean }`，非 owner/admin 剥离 `support_package_storage_url` / `runtime_config` / `llm_config`。

- [x] **Step 1: 写失败测试**

```ts
Deno.test("problems: 匿名读取 private U 题返回 404", async () => {
  const p = await createProblemForTest({ type: "U", visibility: "private" });
  const res = await jsonRequest(app, "GET", `/api/v1/problems/${p.id}`, null);
  assertEquals(res.status, 404);
});
Deno.test("problems: 非 owner 读取 public 题不含 storage_url", async () => {
  const p = await createProblemForTest({ type: "U", visibility: "public",
    support_package_storage_url: "noj-storage://x" });
  const res = await jsonRequest(app, "GET", `/api/v1/problems/${p.id}`, userToken2);
  const data = (await res.json()).data;
  assertEquals(data.support_package_storage_url, undefined);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd noj-core && deno task test -- problems.test.ts`
Expected: FAIL（现状匿名可读 U 题、字段全下发）。

- [x] **Step 3: 实现详情路由 resolver 前置**

`routes/problems.ts` GET /:id handler 内、`getProblem` 之后（GET /:id/questions 同样在读取套卷前做 resolver 判定，无权限 404；该路由现为 optionalAuthMiddleware，套卷私有后竞赛客观题入口由 Task 11 接 contest 上下文）：

```ts
const access = resolveProblemAccess(problem, {
  viewerId: c.var.userId ?? null,
  isAdmin: c.var.isAdmin === true,
});
if (!access.allowed) {
  throw new NotFoundError("题目不存在"); // 404 防存在性探测
}
```

- [x] **Step 4: toProblemResponse 字段分级**

`problems-list.ts` 的 `toProblemResponse(row, viewer)` 追加参数；`!viewer.isOwnerOrAdmin` 时不返回 `support_package_storage_url`、`runtime_config`、`llm_config`。列表查询 WHERE 改为 `visibility='public' AND type='P'`（公开 U 仍不进主列表）。

- [x] **Step 5: 搜索与题单**

- `query/services/search.ts`：`searchProblems` 的 WHERE 追加 `AND p.visibility = 'public'`。
- `catalog/services/trainings.ts`：`listTrainingProblems` 对非 owner/admin 查看者逐题过滤 `visibility='public'`（保留题单自身 private 门）。
- 删除保护（spec §2「被竞赛引用禁删」）：`catalog/services/problems/problems-crud.ts` 的 deleteProblem 在删除前直接查 `contest_problems` 表（shared/db schema 表，不 import contest 域），存在 `problem_id` 引用则抛 `ConflictError("题目已被竞赛引用，无法删除")`。

- [x] **Step 6: 跑相关测试并提交**

Run: `cd noj-core && deno task test:parallel`
Expected: 全绿（既有测试若断言 U 题匿名可读则按新语义更新断言）。

```bash
jj describe -m "feat(core): 题目读路径接入可见性 resolver 与字段分级"
jj new
```

---

### Task 5: contest 域 verifyContestAccess + 赛后放行

**Files:**
- Create: `noj-core/src/domains/contest/services/contest-access.ts`
- Modify: `noj-core/src/domains/contest/index.ts`（导出）
- Test: `noj-core/src/domains/contest/tests/services/contest-access.test.ts`

**Interfaces:**
- Produces:

```ts
export async function verifyContestAccess(
  userId: string | null,
  contestId: string,
  problemId: string,
): Promise<ContestAccessInfo>;
// allowed = 题目在该竞赛 ∧ 用户是参赛者 ∧ (窗口内 OR 已结束)；赛前 → allowed=false
```

- [x] **Step 1: 写失败测试**

构造 running/ended/未开始 三态竞赛 + 参赛/非参赛用户：

```ts
Deno.test("contest-access: running+参赛者 → allowed", async () => {
  const info = await verifyContestAccess(participantId, runningContest.id, problem.id);
  assertEquals(info.allowed, true);
  assertEquals(info.running, true);
});
Deno.test("contest-access: ended+参赛者 → allowed(复盘)", async () => {
  const info = await verifyContestAccess(participantId, endedContest.id, problem.id);
  assertEquals(info.allowed, true);
  assertEquals(info.running, false);
});
Deno.test("contest-access: 赛前 → 拒绝", async () => {
  const info = await verifyContestAccess(participantId, upcomingContest.id, problem.id);
  assertEquals(info.allowed, false);
});
Deno.test("contest-access: 非参赛者 → 拒绝", async () => {
  const info = await verifyContestAccess(strangerId, runningContest.id, problem.id);
  assertEquals(info.allowed, false);
});
```

- [x] **Step 2: 跑测试确认失败**
- [x] **Step 3: 实现**

内部复用 `getContest`/`isParticipant`/`getContestProblems`/`computeContestStatus`；状态 ∈ running/ended 才 allowed。

同时核对 `GET /contests/:id/problems` 与 `GET /contests/:id/problems/:label`（contest/routes/contests.ts）：若现门禁仅放行 running，改为 running 或 ended（参赛者赛后复盘可见），赛前仍拒绝。

- [x] **Step 4: 跑测试确认通过**
- [x] **Step 5: 提交**

```bash
jj describe -m "feat(core): contest 域 verifyContestAccess（成员+窗口+赛后放行）"
jj new
```
---

### Task 6: 提交三入口服务层强制（F-05）

**Files:**
- Modify: `noj-core/src/domains/submission/services/submissions/submissions-crud.ts`（createSubmission）
- Modify: `noj-core/src/domains/submission/services/self-tests.ts`（createSelfTest）
- Modify: `noj-core/src/domains/submission/routes/submissions.ts`（普通路由）
- Modify: `noj-core/src/domains/submission/services/submissions/artifact-submissions.ts`（createArtifactSubmission 同规则）
- Test: `noj-core/src/domains/submission/tests/services/submissions.test.ts`

**Interfaces:**
- Consumes: `resolveProblemAccess`（Task 3）、`verifyContestAccess`（Task 5）。
- Produces: `createSubmission(userId, input, contestId?)` 语义升级——无 contestId 时对 private 题抛 `ForbiddenError`；有 contestId 时先 `verifyContestAccess` 再放行。

- [ ] **Step 1: 写失败测试**

```ts
Deno.test("submissions: 普通入口提交他人 private 题 → Forbidden", async () => {
  await assertRejects(
    () => createSubmission(strangerId, { problem_id: privateProblemId, language: "python3", code: "x" }),
    ForbiddenError,
  );
});
Deno.test("submissions: 参赛者经普通入口提交竞赛私有题 → Forbidden", async () => {
  await assertRejects(
    () => createSubmission(participantId, { problem_id: contestPrivateProblemId, language: "python3", code: "x" }),
    ForbiddenError,
  );
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

在 `createSubmission` 的 `lockedRows` 读取到 problem 之后、语言校验之前插入：

```ts
const contestAccess = resolvedContestId
  ? await verifyContestAccess(userId, resolvedContestId, problem.id)
  : null;
const access = resolveProblemAccess(problem, {
  viewerId: userId,
  isAdmin: false,
  contestAccess,
});
if (!access.allowed) {
  throw new ForbiddenError("无权对该题目提交");
}
```

`createSelfTest` 同样在取到 problem 后加（无 contestId 时 contestAccess=null）：

```ts
const access = resolveProblemAccess(problem, { viewerId: userId, isAdmin: false });
if (!access.allowed) {
  throw new ForbiddenError("无权对该题目自测");
}
```

（admin 调用链经内部服务时用既有 isAdmin 参数/上下文传入；contest 路由已有的参赛者+窗口校验保留为快速失败，真正的强制点在本服务层。）

- [ ] **Step 4: 跑测试确认通过**
Run: `cd noj-core && deno task test -- submissions.test.ts`
- [ ] **Step 5: 提交**

```bash
jj describe -m "fix(core): 提交/自测服务层强制题目可见性与竞赛上下文（F-05）"
jj new
```

---

### Task 7: 建赛加题校验 + kind 规则（含套题洞封堵）

**Files:**
- Modify: `noj-core/src/domains/contest/services/contests.ts`（createContest/updateContest/assertProblemsExist→assertContestProblemAddable）
- Modify: `noj-core/src/domains/contest/routes/contests.ts`（普通用户建赛入口、invite 邀请码必填）
- Modify: `noj-core/src/domains/catalog/services/trainings.ts`（addTrainingProblem 同规则）
- Test: `noj-core/src/domains/contest/tests/services/contests.test.ts`

**Interfaces:**
- Produces: `assertContestProblemAddable(problemIds, creatorId, isAdmin)`：admin 不限；普通用户仅 public 或 owner_id=creator 的题。

- [ ] **Step 1: 写失败测试**

```ts
Deno.test("contests: 普通用户把他人 private 题加入竞赛 → Forbidden", async () => {
  await assertRejects(
    () => createContest({ ...input, problem_ids: [strangersPrivateProblemId] }, normalUserId),
    ForbiddenError,
  );
});
Deno.test("contests: 普通用户创建 invite 未带密码 → BadRequest", async () => {
  await assertRejects(
    () => createContest({ ...input, kind: "invite", password: undefined }, normalUserId),
    BadRequestError,
  );
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

`assertContestProblemAddable`：

```ts
async function assertContestProblemAddable(
  problemIds: string[], creatorId: string, isAdmin: boolean, tx: DbTx,
) {
  if (isAdmin) return;
  const rows = await tx.select().from(problems)
    .where(inArray(problems.id, problemIds));
  for (const p of rows) {
    if (p.visibility !== "public" && p.owner_id !== creatorId) {
      throw new ForbiddenError("仅可加入公开题或自己拥有的题目");
    }
  }
}
```

createContest/updateContest 调用点替换 `assertProblemsExist`；`trainings.ts` 的 `addTrainingProblem` 加同样的 visibility/public 或 owner 校验。

建赛路由：普通用户（有 `contest:create` 权限）仅允许 `kind='invite'` 且 `password` 非空；`kind='public'` 需 admin。

- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交**

```bash
jj describe -m "fix(core): 建赛/加题校验封堵套题洞，普通用户仅可建 invite 赛"
jj new
```

---

### Task 8: F-04 提交限额 Redis 原子预算

**Files:**
- Modify: `noj-core/src/domains/contest/services/contests.ts`（assertContestSubmissionLimit）
- Test: `noj-core/src/domains/contest/tests/services/contests.test.ts`

**Interfaces:**
- Consumes: `getRedis()`（shared/mq）、contest.config 中 submission_limits（既有读取逻辑）。
- Produces: `assertContestSubmissionLimit` 改为 Redis INCR 原子扣减 + EXPIRE 至 end_time；超限抛 `RateLimitedError`。

- [ ] **Step 1: 写失败测试**：同一用户按 limit 提交 N 次后第 N+1 次抛 `RateLimitedError`。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

替换现 count-then-insert 逻辑为：

```ts
const redis = getRedis();
const key = `contest:lim:${contestId}:u:${userId}:p:${problemId}`;
const used = await redis.incr(key);
if (used === 1) {
  const ttl = Math.max(1, Math.floor((Date.parse(contest.end_time) - Date.now()) / 1000));
  await redis.expire(key, ttl);
}
if (used > limit) {
  throw new RateLimitedError("提交次数已达上限");
}
```

DB 计数保留展示（对账），不在插入路径做 count 判定。

- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交**

```bash
jj describe -m "fix(core): 竞赛提交限额改 Redis 原子预算（F-04）"
jj new
```

---

### Task 9: 竞赛注册 kind 语义 + F-13 限流

**Files:**
- Modify: `noj-core/src/domains/contest/routes/contests.ts`（POST /:id/register）
- Modify: `noj-core/src/domains/contest/services/contests.ts`（registerForContest）
- Modify: `noj-core/src/domains/system/services/hardening-rate-limit.ts`（新增竞赛注册限流 helper）
- Test: `noj-core/src/domains/contest/tests/routes/contests.test.ts`

**Interfaces:**
- Produces: `enforceContestRegisterRateLimit(c, contestId)`；`registerForContest` 新语义：invite 必须校验 password 匹配，public 无码自助。

- [ ] **Step 1: 写失败测试**：invite 赛无邀请码注册 → 400；错误邀请码 → 403；public 无码 → 成功。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

`registerForContest`：按 `contest.kind` 分支——invite 必须传 password 且常量时间比较匹配（沿用现有密码比较方式）；public 有 password 时校验、无 password 直接注册。

`hardening-rate-limit.ts` 追加：

```ts
/** 竞赛注册：IP+竞赛维度限流。 */
export async function enforceContestRegisterRateLimit(
  c: Context, contestId: string,
): Promise<void> {
  await enforceRateLimit(
    `contest-register:ip:${getClientIp(c)}:c:${contestId}`,
    { windowSeconds: 30, maxAttempts: 5 },
    "注册过于频繁，请稍后重试",
  );
}
```

路由 handler 在 registerForContest 前调用。

- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交**

```bash
jj describe -m "fix(core): 竞赛注册按 kind 语义校验邀请码并加限流（F-13）"
jj new
```
---

### Task 10: 统一结果投影 applySubmissionProjection

**Files:**
- Create: `noj-core/src/domains/submission/services/submissions/submission-projection.ts`
- Test: `noj-core/src/domains/submission/tests/services/submission-projection.test.ts`

**Interfaces:**
- Produces:

```ts
export type ProjectionCtx = {
  viewerId: string | null;
  isAdmin: boolean;
  isOwner: boolean;        // 提交者本人或题目 owner
  contest?: { running: boolean; participant: boolean } | null;
};

export function applySubmissionProjection<T extends Record<string, unknown>>(
  submission: T, ctx: ProjectionCtx,
): T;
// 规则：
// - isAdmin || isOwner → 原样
// - contest.running && participant && viewer===提交者 → 保留 status/score，剥 details/subtasks/testCases；visible 用例保留、hidden 剥除
// - contest 赛后 && participant && viewer===提交者 → score+status 恢复；hidden 仍剥
// - contest.running && 他人 → 仅 { id, problem_id, status }
// - 无 contest → 原样（public 题提交公开，现状）
```

- [ ] **Step 1: 写失败测试**：六档位矩阵（含 hidden/visible 用例剥离、赛后恢复、他人仅存在级）。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

纯函数：结构化深拷贝后按档位删除字段。visible/hidden 依据 `details.cases[].hidden` 标记；无标记一律按 hidden 剥除（fail-safe）。

- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交**

```bash
jj describe -m "feat(core): 统一提交结果投影函数（F-02/F-15 基础）"
jj new
```

---

### Task 11: 投影接入读路径 + SSE + 队列（F-02/F-15）

**Files:**
- Modify: `noj-core/src/domains/submission/routes/submissions.ts`（GET /:id）
- Modify: `noj-core/src/domains/submission/services/queue.ts`（getQueueOverview 过滤竞赛提交）
- Modify: `noj-core/src/domains/contest/routes/sse.ts`（频道成员校验 + 投影推送）
- Test: `noj-core/src/domains/submission/tests/routes/submissions.test.ts`、queue 相关测试

**Interfaces:**
- Consumes: `applySubmissionProjection`（Task 10）、`verifyContestAccess`（Task 5）。

- [ ] **Step 1: 写失败测试**

```ts
Deno.test("submissions: 赛中他人查看竞赛提交仅存在级信息", async () => {
  const res = await jsonRequest(app, "GET", `/api/v1/submissions/${contestSubId}`, strangerToken);
  const data = (await res.json()).data;
  assertEquals(data.score, undefined);
  assertEquals(data.status, "judging"); // 仅状态存在
});
Deno.test("queue: 全局队列不显示竞赛提交给普通用户", async () => {
  const res = await jsonRequest(app, "GET", "/api/v1/submissions/queue", strangerToken);
  const ids = (await res.json()).data.pending.map((x: { id: string }) => x.id);
  assertEquals(ids.includes(contestSubId), false);
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

- GET /:id：optionalAuth 取 viewerId；若该提交属于竞赛（contest_id 非空），`verifyContestAccess` 判定 viewer 身份后过 `applySubmissionProjection`。
- `getQueueOverview`：`queryQueueRows` 增加 `contest_id IS NULL` 过滤（普通用户视角）；管理员视角（isAdmin 参数）不过滤。
- sse.ts：`contestSubmission(id)` 频道订阅时校验 `isParticipant`（复用现有门禁同款逻辑，改为 kind/成员判定）；发布内容过投影。
- 客观题竞赛取题：`GET /problems/:id/questions` 支持 `?contest_id=` 参数（optionalAuth 下解析 contest 上下文 → `verifyContestAccess` → resolver 放行）；同步修改 `noj-ui/pages/contests/[contestId]/problems/[label].vue:114` 取题调用带上 `contest_id`（避免 private 套卷在竞赛页 404）。

- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交**

```bash
jj describe -m "fix(core): 提交详情/全局队列/SSE 接入投影，运行中竞赛信息隐藏（F-02/F-15）"
jj new
```

---

### Task 12: 客观题写入剥离 + 解析门（F-01/F-14）

**Files:**
- Modify: `noj-core/src/domains/objective/services/objective-submissions.ts`（写入剥离 details.expected；练习提交解析门）
- Modify: `noj-core/src/domains/objective/services/objective-questions.ts`（读题接入 resolver，如需）
- Test: `noj-core/src/domains/objective/tests/services/objective-submissions.test.ts`

**Interfaces:**
- Consumes: `resolveProblemAccess`（Task 3）。
- Produces: 入库 `details` 不再含 expected；`toSubmissionResponse`/练习列表 withExplanation 仅 public paper/owner/admin 返回。

- [ ] **Step 1: 写失败测试**

```ts
Deno.test("objective: 练习提交响应不含 expected（private paper）", async () => {
  const sub = await submitObjectivePaper(normalUserId, privatePaperId, answers);
  const json = JSON.stringify(sub);
  assertEquals(json.includes("expected"), false);
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

- 写入（F-14）：`objective-submissions.ts` 插入前对 `judgement.details` 执行 `stripExpected`（复用既有函数，现仅用于响应裁剪，提前到写入），入库不含 expected；
- 读取（F-01）：练习提交响应 `withExplanation` 前判 `paper.visibility === 'public' || viewer 为 owner/admin`，否则走 `stripExpected`；
- 竞赛客观题提交走 Task 10 投影（running 参赛者仅 score+对错状态）。

- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交**

```bash
jj describe -m "fix(core): 客观题写入剥离 expected 并收紧练习解析（F-01/F-14）"
jj new
```

---

### Task 13: judge 结果 details 白名单（F-11）

**Files:**
- Modify: `noj-core/src/domains/submission/mq/consumer.ts`（结果落库前 sanitize）
- Test: `noj-core/src/domains/submission/tests/mq/consumer.test.ts`（或现有）

**Interfaces:**
- Produces: `sanitizeJudgeDetails(details: Record<string, unknown>): Record<string, unknown>` — key 白名单（`cases`/`score` 等安全键，按现有 evaluate.py 契约定义）+ 单值大小上限（64KB），超限丢弃。

- [ ] **Step 1: 写失败测试**：details 含未知 key/超大字符串 → 落库后不存在。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（consumer 在 `saveEvaluationResult` 前调用 sanitize）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交**

```bash
jj describe -m "fix(core): judge 结果 details 白名单化与大小上限（F-11）"
jj new
```---

### Task 14: F-07 judge 每用户并发上限 1（全局不限制）

**Files:**
- Modify: `noj-core/src/domains/submission/types/index.ts`（JudgeTask + user_id）
- Modify: `noj-core/src/domains/submission/mq/producer.ts`（填充 user_id）
- Modify: `noj-judge/src/types.rs`（JudgeTask + user_id）
- Modify: `noj-judge/src/main.rs`（移除全局 Semaphore 闸门，改 per-user active 集合）
- Modify: `noj-judge/src/mq.rs`（任务拉取循环：活跃用户任务回队）
- Test: judge 调度逻辑单元测试（新增于 `noj-judge/src/mq.rs` `#[cfg(test)]` 或 `noj-judge/tests/`）

**Interfaces:**
- Consumes: submission 行的 `user_id`（producer 侧已有）。
- Produces: `JudgeTask.user_id: string`；judge 调度：`Arc<Mutex<HashSet<String>>> active_users`。

- [ ] **Step 1: 两侧类型加 user_id**

core `types/index.ts` JudgeTask 加：

```ts
/** 提交用户 UUID（judge 公平调度用）。 */
user_id: string;
```

judge `types.rs` JudgeTask 加：

```rust
/// 提交用户 UUID（公平调度：同一用户同时最多 1 个评测在跑）。
pub user_id: String,
```

- [ ] **Step 2: producer 填充**

`producer.ts` 构造 task 时：

```ts
const task: JudgeTask = {
  submission_id, problem_id, user_id: submission.user_id,
  runtime_config, /* ...其余字段不变 */
};
```

- [ ] **Step 3: 写失败测试（judge 调度）**

```rust
#[tokio::test]
async fn per_user_limit_skips_active_users() {
    // 队列 [userA 任务1, userA 任务2, userB 任务1]；userA active
    // 断言取出的是 userB 的任务，userA 任务2 回到队尾
}
```

- [ ] **Step 4: 跑测试确认失败**
Run: `cd noj-judge && cargo nextest run --all-targets`
- [ ] **Step 5: 实现调度**

`main.rs`：删除 `judge_semaphore` 的 acquire 闸门（保留 Semaphore 用于 drain 逻辑，若有）；新增：

```rust
let active_users: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
```

取任务循环（mq.rs 或 main.rs）：BRPOPLPUSH 取出 task 后：

```rust
let mut guard = active_users.lock().await;
if guard.contains(&task.user_id) {
    // 活跃用户任务放回队尾，轮给他人
    redis_conn.lpush(judge_queue, serialized_task).await?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    continue;
}
guard.insert(task.user_id.clone());
```

评测完成（含 error）后 `guard.remove(&task.user_id)`。

- [ ] **Step 6: 跑测试确认通过 + fmt/clippy**
Run: `cd noj-judge && cargo fmt && cargo clippy && cargo nextest run --all-targets`
Expected: 全绿、零警告。
- [ ] **Step 7: 提交**

```bash
jj describe -m "feat(judge): 每用户并发上限 1 公平调度，移除全局槽闸门（F-07）"
jj new
```

---

### Task 15: F-08 judge 流式解压 + deadline 从注入起算

**Files:**
- Modify: `noj-judge/src/sandbox/download.rs`（流式落盘）
- Modify: `noj-judge/src/dual/mod.rs`（deadline 起点移至注入前）
- Test: `noj-judge/tests/e2e_support_package.rs`（既有，补充大包用例）

**Interfaces:**
- Produces: 下载直接写 `WorkDir` 文件（`tokio::io::copy` 到 File），不再 `Vec<u8>` 整体驻留；`deadline = Instant::now() + 30s` 在注入阶段开始前创建。

- [ ] **Step 1: 写失败测试**：构造大支持包（测试环境可经 `#[cfg(test)]` 注入阈值），断言下载后内存峰值（metrics.rs 既有）低于阈值。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

`download.rs` 把 `let bytes = reqwest::...bytes().await?` 改为：

```rust
let mut file = tokio::fs::File::create(&dest_path).await?;
let mut stream = response.bytes_stream();
while let Some(chunk) = stream.next().await {
    file.write_all(&chunk?).await?;
}
```

`dual/mod.rs`：注入 zip 步骤前 `let deadline = Instant::now() + Duration::from_secs(30);`，其后所有超时检查统一用该 deadline（不再从评测启动重新计时）。

- [ ] **Step 4: 跑测试确认通过 + fmt/clippy**
- [ ] **Step 5: 提交**

```bash
jj describe -m "fix(judge): 支持包流式落盘与注入计入总时限（F-08）"
jj new
```

---

### Task 16: F-12 注册邮箱验证开关

**Files:**
- Modify: `noj-core/src/domains/identity/routes/auth.ts`（POST /register）
- Modify: `noj-core/src/shared/config/settings-registry.ts` + `noj-core/.env.example`（新 env 登记）
- Test: `noj-core/src/domains/identity/tests/routes/auth.test.ts`

**Interfaces:**
- Produces: `REGISTER_EMAIL_VERIFY`（默认 off）。开启后 `/register` 需 `{ email_code }` 且与邮箱验证码一致（复用 email provider 策略与验证码通道，参考密码重置验证码实现）。

- [ ] **Step 1: 写失败测试**：开关 on 时无验证码注册 → 400。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（注册表登记 `register_email_verify`，env 读取 `REGISTER_EMAIL_VERIFY`，默认 false；auth.ts 分支校验）
- [ ] **Step 4: 跑测试确认通过 + `deno task check:env`**
- [ ] **Step 5: 提交**

```bash
jj describe -m "feat(core): 注册邮箱验证开关（默认关）（F-12）"
jj new
```---

### Task 17: 运营后台（core admin 路由 + noj-ui）

**Files:**
- Modify: `noj-core/src/domains/catalog/routes/admin-problems.ts`（评定队列：待转公开/待转 P 列表 + 批量）
- Modify: `noj-core/src/domains/contest/routes/admin-contests.ts`（kind 翻转、邀请码重置）
- Modify: `noj-core/src/domains/catalog/routes/problems.ts`（owner 转 public setter）
- Modify: `noj-ui/pages/admin/problems.vue` / `noj-ui/pages/admin/contests.vue`（后台页面）
- Modify: `noj-ui/pages/contests/[contestId]/index.vue`（建赛向导 kind=invite 默认）
- Test: `noj-core/src/domains/catalog/tests/routes/admin-problems.test.ts`

**Interfaces:**
- Consumes: `problem:create_p`（U→P）、`problem:write_own`（owner 转 public）、`contest:create`。
- Produces: `POST /api/v1/admin/problems/review`（批量转公开/转 P）、`PATCH /api/v1/admin/contests/:id/kind`、`POST /api/v1/admin/contests/:id/reset-code`、`PUT /api/v1/problems/:id/visibility`。

- [ ] **Step 1: 写失败测试**：非 admin 调评定队列 → 403；owner 转 public 成功；U→P 需 create_p。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 admin 路由**（三个端点 + 权限中间件，按现有 admin-* 路由模式）
- [ ] **Step 4: UI**

- admin/problems.vue：新增"题目评定"tab（待转公开/待转 P 列表，批量勾选+按钮调对应端点）；
- admin/contests.vue：竞赛行加"转公开赛"与"重置邀请码"操作；
- 建赛向导：kind 默认 invite、密码必填；public 选项对无权限用户禁用并提示联系管理员。

- [ ] **Step 5: 跑测试确认通过**
- [ ] **Step 6: 提交**

```bash
jj describe -m "feat(core,ui): 运营后台题目评定队列与竞赛 kind 管理"
jj new
```

---

### Task 18: e2e 攻击剧本

**Files:**
- Create: `noj-tests/e2e/30_contest_anti_cheat.test.ts`

**Interfaces:**
- Consumes: 全部已实现端点；参考 `noj-tests/e2e/22_contest_lifecycle.test.ts` 的建赛/注册辅助。

- [ ] **Step 1: 编写剧本**（7 个场景，对应 spec §12）：

```ts
// 场景 1: 无上下文直取私有题 → 404
// 场景 2: 伪造 contestId 提交 → 403/400
// 场景 3: 竞赛入口重复提交超 submission_limits → 429；普通入口对私有题 → 403
// 场景 4: 他人私有题加入自己竞赛/题单 → 403
// 场景 5: 非参赛者订阅 SSE contestSubmission → 无事件
// 场景 6: 赛中提交详情/全局队列不泄判据
// 场景 7: 客观题练习提交不泄 expected（private paper）
```

- [ ] **Step 2: 跑 e2e**
Run: `cd noj-tests && deno task test -- e2e/30_contest_anti_cheat.test.ts`（或按 E2E_TESTING.md 指南）
Expected: 全绿。
- [ ] **Step 3: 提交**

```bash
jj describe -m "test(e2e): 竞赛防作弊攻击剧本 30_contest_anti_cheat"
jj new
```

---

### Task 19: 文档同步与 Agent Note

**Files:**
- Modify: `noj-docs/docs/system/security.md`（可见性/投影/kind 模型）
- Modify: `noj-core/data/problems-src/1001/evaluate.py`（cases 加 hidden 标记，样例遵循新契约）
- Create/Modify: 出题指南（visible/hidden 标记、evaluate.py 契约、不印 hidden 细节）
- Modify: `noj-core/CLAUDE.md`（visibility/kind 列速查提及）
- Create: `.agents/notes/implemented/architecture/2026-09-05-contest-anti-cheat-fix.md`

- [ ] **Step 1: 更新文档**（按上文清单；中文）
- [ ] **Step 2: 校验 Agent Note 格式**
Run: `deno run -A scripts/verify-agent-note-format.ts`
- [ ] **Step 3: 提交**

```bash
jj describe -m "docs(root): 竞赛防作弊修复文档同步与 Agent Note"
jj new
```

## 收尾

- [ ] `cd noj-core && deno task test:parallel` 全绿
- [ ] `cd noj-judge && cargo fmt && cargo clippy && cargo nextest run --all-targets` 全绿零警告
- [ ] `cd noj-tests && deno task test` e2e 全绿
- [ ] 向用户报告，等待决定推送（禁直推 main）




