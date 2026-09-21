# 移除 BYOK 全路径实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 干净移除 BYOK（用户自带模型）全路径，保留平台/管理员 Provider 与题目 LLM 能力，并记录日后重建指引。

**Architecture:** 跨 5 模块的协调删除。按依赖自底向上执行：先收窄 judge 契约消费方，再删 core 契约/数据/路由，然后 gateway 归属模型与迁移，最后 UI、文档与决策记录。仓库单仓同版本部署，无中间态兼容需求。

**Tech Stack:** Deno 2 + Hono + Drizzle（core）；Rust + Tokio + serde（judge）；Deno + Hono + postgres.js（gateway）；Nuxt 4 + Vue 3（ui）。

**Spec:** `dev-docs/superpowers/specs/2026-09-21-remove-byok-full-path-design.md`

## Global Constraints

- 所有提交必须 GPG 签名；`jj describe` 设提交信息，`jj new` 开新提交。
- 提交信息格式：`<type>(<scope>): <中文描述>`，scope ∈ `core` / `ui` / `judge` / `root`。
- 语言：注释、文档、提交描述用中文；代码标识符用英文。
- Deno 测试必须用 `deno task`，禁止手拼 `deno test`。按域测试：`cd noj-core && deno task test:domain <domain>`。
- 格式/静态检查：`deno fmt` + `deno lint`；Rust `cargo fmt` + `cargo clippy`。
- 禁止手动修改 `deno.lock` / `Cargo.lock` / `_journal.json`。
- 迁移只能追加；core 迁移由 `deno task db:generate` 生成。
- 保留边界（判据 `created_by === "0"`）：管理员 Provider 管理（`admin/routes/gateway.ts`、`admin/llm/*.vue`、`listLlmProviders` / `getLlmProviderById` / `createLlmProvider` / `updateLlmProvider`）、题目平台 LLM（`problem.llm` → `buildJudgeTaskLlm` → `JudgeTask.llm`）、gateway `/v1/chat/completions` 与 `llm_usage` / `llm_quotas`。
- `cost_per_1k_tokens` 数值夹取 `[0, 1e6]` 保留，仅改注释措辞。
- 不可逆：用户 Provider 行及其加密 Key 将被 DELETE，执行迁移前须备份。

---

## File Structure

**契约（跨模块，必须同一提交）**
- `noj-core/src/domains/submission/types/index.ts` — JudgeTask 契约定义，删 `user_llm`
- `noj-tests/fixtures/judge-task.contract.json` — 契约快照
- `noj-core/src/domains/submission/tests/types/judge-task-contract.test.ts` — core 侧契约断言
- `noj-judge/src/types.rs` — Rust 镜像结构体
- `noj-judge/tests/judge_task_contract.rs`、`noj-judge/tests/e2e_dual_container.rs` — judge 侧契约断言

**judge 运行时**
- `noj-judge/src/dual/mod.rs` — capability 分支与 BYOK 处理函数
- `noj-judge/src/judge/runner.rs` — 调用点

**core 数据面**
- `noj-core/src/shared/db/schema/submission.ts`、`schema-ddl.ts`、`drizzle/00xx_*.sql`（生成）

**core 服务/路由面**
- `noj-core/src/domains/submission/routes/submissions.ts`
- `noj-core/src/domains/submission/services/submissions/{submissions-crud,artifact-submissions,submissions-rejudge,submissions-types}.ts`
- `noj-core/src/domains/submission/mq/sweeper.ts`
- `noj-core/src/domains/identity/routes/users.ts`
- `noj-core/src/domains/gateway/services/{llm,llm-token}.ts`

**gateway**
- `noj-llm-gateway/src/{providers.ts,routes/internal.ts,routes/llm.ts,config-registry.ts,db/schema.ts}`
- `noj-llm-gateway/drizzle/0002_remove_byok_created_by.sql`（新增）
- `noj-llm-gateway/tests/{providers_test.ts,config_registry_test.ts,helpers.ts}`

**UI / 文档 / 基建**
- `noj-ui/pages/settings.vue`、`noj-ui/components/editor/EditorWorkspace.vue`、`noj-ui/pages/editor/[id].vue`
- `noj-docs/docs/users/byok.md`（删除）、`users/index.md`、`.vitepress/config.ts`、`operators/production-secrets.md`
- `docker-compose.yml`、`docker-compose.e2e.yml`、`docker-compose.prod.yml`、`.env.prod.example`、`noj-llm-gateway/.env.example`、`noj-llm-gateway/README.md`
- `noj-judge/AGENTS.md`、`dev-docs/engineering/route-catalog.md`（重生成）
- `.agents/notes/implemented/simplification/2026-09-21-remove-byok-full-path.md`（新增）

---

## Task 1: judge 侧移除 user_llm 契约与 capability 分支

**Files:**
- Modify: `noj-judge/src/types.rs`
- Modify: `noj-judge/src/dual/mod.rs`
- Modify: `noj-judge/src/judge/runner.rs`
- Modify: `noj-judge/tests/judge_task_contract.rs`
- Modify: `noj-judge/tests/e2e_dual_container.rs`

**Interfaces:**
- Consumes: 无（本任务只删除）
- Produces: `JudgeTask` 不再有 `user_llm` 字段；`dual` 模块只保留唯一入口 `evaluate_dual_with_cpu_limit`（原 `_and_user_llm` 变体的实现合并进来，删除重复的 wrapper）；`request_user_llm_completion` capability 不再有特殊分支，回落到通用转发。

- [ ] **Step 1: 让契约测试先失败**

修改 `noj-judge/tests/judge_task_contract.rs`：删除第 55-56 行 `let user_llm = ...` 与断言、删除字段集断言里的 `"user_llm"` 条目（原第 79 行）。

```rust
// 删除：
// let user_llm = task.user_llm.expect("fixture 应包含 user_llm 字段");
// assert_eq!(user_llm.allowed_models, vec!["gpt-4o-mini"]);
// 以及字段列表中的 "user_llm",
```
同时修改 `noj-tests/fixtures/judge-task.contract.json`，删除 `user_llm` 对象（原第 31-34 行）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-judge && cargo nextest run --all-targets -E 'test(judge_task_contract)'`
Expected: FAIL（Rust 结构体仍有 `user_llm`，反序列化 fixture 缺字段报错；或字段集断言不一致）

- [ ] **Step 3: 删除 Rust 契约字段**

在 `noj-judge/src/types.rs` 删除：

```rust
    /// 用户 BYOK LLM 字段；仅由 judge 处理，不注入 Evaluator 环境。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_llm: Option<JudgeTaskLlm>,
```

- [ ] **Step 4: 删除 capability 特殊分支与处理函数**

在 `noj-judge/src/dual/mod.rs`：

1. 删除 `handle_user_llm_capability`、`user_llm_error_frame`、`map_user_llm_gateway_error` 三个函数。
2. 删除 `FRAME_CAPABILITY` 处理中 `request_user_llm_completion` 的特殊分支（原约 1058-1060 行）：

```rust
                    if v.get("name").and_then(Value::as_str) == Some("request_user_llm_completion")
                    {
                        handle_user_llm_capability(sol_input, &v, user_llm).await?;
```
改为不拦截，让该帧走通用转发逻辑（与其它 capability 一致）。
3. 删除重复入口：`evaluate_dual_with_cpu_limit`（原约 283 行）当前只是把 `user_llm=None` 转发给 `evaluate_dual_with_cpu_limit_and_user_llm`（原约 348 行）。将 `_and_user_llm` 的**实现体**改名为 `evaluate_dual_with_cpu_limit` 并删除 `user_llm: Option<&JudgeTaskLlm>` 参数（原第 357 行），同时删除原 wrapper 函数体。
   - 理由：移除 `user_llm` 参数后两者签名完全一致，保留两个入口会让"`and_user_llm`"成为误导性死名。合并后 **全部调用点（生产 1 处 + 测试 16 处）无需改名**，测试零改动。
   - 传递链：内部函数（原第 488、598、837、1033 行的参数）删除 `user_llm` 传递。
4. 删除所有 `#[cfg(test)]` 中 capability 相关测试（`test_user_llm_capability_*`、`test_user_llm_error_frame_shape`、`test_map_user_llm_gateway_error`）。
5. 删除因移除参数而不再使用的 `use`（以 `cargo clippy` 结果为准）。

- [ ] **Step 5: 更新调用点**

在 `noj-judge/src/judge/runner.rs` 将调用改为 `evaluate_dual_with_cpu_limit` 并删除 `task.user_llm.as_ref(),`（原第 115 行）：

```rust
    crate::dual::evaluate_dual_with_cpu_limit(
        docker,
        &task.submission_id,
        &task.runtime_config,
        &task.code,
        support_pkg.as_ref().map(|p| p.path.as_path()),
        artifact_zip.as_ref().map(|p| p.path.as_path()),
        task.rejudge_seq,
        task.llm.as_ref(),
        cpu_limit_millicores,
        allow_evaluator_network,
        evaluator_network_mode,
        image_prefix,
        command_whitelist,
        max_evaluator_time_ms,
        max_solution_call_timeout_ms,
    )
```

在 `noj-judge/tests/e2e_dual_container.rs` 删除 `user_llm: None,`（原第 66 行）；其余 `evaluate_dual_with_cpu_limit(...)` 测试调用保持不变。

- [ ] **Step 6: 运行构建与测试**

Run: `cd noj-judge && cargo fmt && cargo clippy --all-targets -- -D warnings`
Expected: PASS（无警告）

Run: `cd noj-judge && cargo nextest run --all-targets -E 'test(judge_task_contract) | test(dual)'`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "refactor(judge): 移除 BYOK user_llm 契约与 capability 分支"
jj new
```

---

## Task 2: core 契约层移除 user_llm

**Files:**
- Modify: `noj-core/src/domains/submission/types/index.ts`
- Modify: `noj-core/src/domains/submission/tests/types/judge-task-contract.test.ts`

**Interfaces:**
- Consumes: Task 1 已让 judge 侧不再需要 `user_llm`
- Produces: `JudgeTask` / `BuildJudgeTaskInput` 不再有 `user_llm`；`buildJudgeTask` 不再写入；`JUDGE_TASK_FIELDS` 不含 `"user_llm"`。

- [ ] **Step 1: 让契约测试先失败**

修改 `noj-core/src/domains/submission/tests/types/judge-task-contract.test.ts`：删除第 45、66 行的 `user_llm: fixture.user_llm,`（fixture 已在 Task 1 删除该字段，故此处会编译/断言失败）。

Run: `cd noj-core && deno task test:domain submission`
Expected: FAIL

- [ ] **Step 2: 删除 core 契约字段**

在 `noj-core/src/domains/submission/types/index.ts` 删除：

```ts
  /** 用户 BYOK LLM 字段；只供 judge 处理，不注入 Evaluator 环境。 */
  user_llm?: JudgeTaskLlm;
```
（`JudgeTask` 与 `BuildJudgeTaskInput` 各一处），以及 `buildJudgeTask` 中：

```ts
  if (input.user_llm !== undefined) task.user_llm = input.user_llm;
```
和 `JUDGE_TASK_FIELDS` 中的 `"user_llm",`（原第 122 行）。

- [ ] **Step 3: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain submission`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "refactor(core): 移除 JudgeTask user_llm 契约字段"
jj new
```

---

## Task 3: core 提交服务与路由移除 BYOK

**Files:**
- Modify: `noj-core/src/domains/submission/services/submissions/submissions-crud.ts`
- Modify: `noj-core/src/domains/submission/services/submissions/artifact-submissions.ts`
- Modify: `noj-core/src/domains/submission/services/submissions/submissions-rejudge.ts`
- Modify: `noj-core/src/domains/submission/services/submissions/submissions-types.ts`
- Modify: `noj-core/src/domains/submission/mq/sweeper.ts`
- Modify: `noj-core/src/domains/submission/routes/submissions.ts`

**Interfaces:**
- Consumes: Task 2 已删 `JudgeTask.user_llm`
- Produces: `SubmissionInput` 不再有 `llm_provider_config_id`；提交创建/rejudge/sweeper 不再构造 `user_llm` 任务；路由不再解析该字段。

- [ ] **Step 1: 删服务层构造**

在 `submissions-crud.ts` 删除 `userLlmTask` 变量、`getUserLlmProvider` / `buildJudgeTaskLlmForProvider` 调用块、`user_llm: userLlmTask ?? undefined` 传参，以及相关 import。
在 `artifact-submissions.ts` 同样删除 `userLlmTask` 块与 `user_llm` 传参、`input.user_llm` 校验块、import。
在 `submissions-rejudge.ts` 删除两处 `userLlmTask` 块（原约 141-172 行、360-391 行）、`sub.llm_provider_config_id` / `submission.llm_provider_config_id` 读取、`user_llm` 传参、import。

- [ ] **Step 2: 删 sweeper BYOK 恢复块**

在 `mq/sweeper.ts` 删除原第 293-318 行的 `if (row.user_id && row.llm_provider_config_id) { ... }` 整块、`selectFields` 中的 `llm_provider_config_id`、行类型中的该字段。

- [ ] **Step 3: 删类型与路由字段**

在 `submissions-types.ts` 删除 `llm_provider_config_id?: string;`（原第 16 行）。
在 `routes/submissions.ts` 删除 JSON body 类型字段（原第 121 行）、`llmProviderConfigId` 变量（原第 132 行）与 body 传参（原第 148 行）、multipart 分支 `if (name === "llm_provider_config_id")`（原第 155 行）、服务调用传参（原第 235 行）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain submission`
Expected: PASS

Run: `cd noj-core && deno fmt --check && deno lint`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "refactor(core): 提交服务与路由移除 BYOK 载荷"
jj new
```

---

## Task 4: core 移除用户 Provider 客户端与 identity 路由

**Files:**
- Modify: `noj-core/src/domains/gateway/services/llm.ts`
- Modify: `noj-core/src/domains/gateway/services/llm-token.ts`
- Modify: `noj-core/src/domains/identity/routes/users.ts`

**Interfaces:**
- Consumes: 无
- Produces: `gateway/services/llm.ts` 仅保留管理员侧 4 个函数（`listLlmProviders` / `getLlmProviderById` / `createLlmProvider` / `updateLlmProvider`）；`llm-token.ts` 仅保留 `buildJudgeTaskLlm`；`/api/v1/users/me/llm-providers*` 5 条路由消失。

- [ ] **Step 1: 删 gateway 客户端用户侧函数**

在 `noj-core/src/domains/gateway/services/llm.ts` 删除 `listUserLlmProviders` / `getUserLlmProvider` / `createUserLlmProvider` / `updateUserLlmProvider` / `deleteUserLlmProvider` / `testUserLlmProvider`。保留 `listLlmProviders` / `getLlmProviderById` / `createLlmProvider` / `updateLlmProvider` 及 `request` 封装。

- [ ] **Step 2: 删 llm-token 用户侧构造函数**

在 `noj-core/src/domains/gateway/services/llm-token.ts` 删除 `buildJudgeTaskLlmForProvider`。保留 `buildJudgeTaskLlm`。

- [ ] **Step 3: 删 identity 用户路由**

在 `noj-core/src/domains/identity/routes/users.ts` 删除 5 条 `users.get/post/put/delete("/me/llm-providers...")` handler（原第 52-140 行区间）及其 import
（`createUserLlmProvider` / `deleteUserLlmProvider` / `listUserLlmProviders` / `testUserLlmProvider` / `updateUserLlmProvider`、`LlmGatewayError` 若仅此处使用）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain identity`
Expected: PASS

Run: `cd noj-core && deno task test:domain gateway`
Expected: PASS

- [ ] **Step 5: 重生成路由目录并检查**

Run: `deno run -A scripts/gen-route-catalog.ts`
Expected: `dev-docs/engineering/route-catalog.md` 不再含 `/me/llm-providers`。

- [ ] **Step 6: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "refactor(core): 移除用户 BYOK Provider 客户端与 /me/llm-providers 路由"
jj new
```

---

## Task 5: core DROP 列迁移与 schema 同步

**Files:**
- Modify: `noj-core/src/shared/db/schema/submission.ts`
- Modify: `noj-core/src/shared/db/schema-ddl.ts`
- Create: `noj-core/drizzle/00xx_*.sql`（由 db:generate）

**Interfaces:**
- Consumes: Task 3、Task 4 已无该列的任何代码引用
- Produces: `submissions` 表无 `llm_provider_config_id` 列与索引；新增 DROP 迁移。

- [ ] **Step 1: 删 schema 定义**

在 `noj-core/src/shared/db/schema/submission.ts` 删除：

```ts
    /** 可选的用户 BYOK Provider；密钥由 noj-llm-gateway 托管 */
    llm_provider_config_id: text("llm_provider_config_id"),
```
以及 `llm_provider_config_idx: index("idx_submissions_llm_provider_config_id").on(table.llm_provider_config_id),`。

- [ ] **Step 2: 删 schema-ddl 两行**

在 `noj-core/src/shared/db/schema-ddl.ts` 删除：
- 第 258 行 `llm_provider_config_id TEXT,`（位于 submissions 建表列清单）
- 第 750 行 `"CREATE INDEX IF NOT EXISTS idx_submissions_llm_provider_config_id ON submissions (llm_provider_config_id)",`

- [ ] **Step 3: 生成迁移**

Run: `cd noj-core && deno task db:generate`
Expected: 新增 `drizzle/00xx_*.sql`，内容含
`ALTER TABLE "submissions" DROP COLUMN "llm_provider_config_id";`
并更新 `meta/_journal.json`（自动，勿手改）。

- [ ] **Step 4: 校验迁移安全与快照链**

Run: `deno run -A scripts/check-migration-safety.ts`
Expected: PASS

Run: `deno run -A scripts/check-migration-snapshot-chain.ts`
Expected: PASS（区间内有显式 DROP）

- [ ] **Step 5: 在存量库验证迁移**

Run: `cd noj-core && deno task db:migrate`
Expected: 迁移成功（在已有数据的库上执行 `DROP COLUMN` 成功）。

- [ ] **Step 6: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "refactor(core): DROP submissions.llm_provider_config_id 列与索引"
jj new
```

---

## Task 6: gateway 移除 BYOK 归属模型与迁移

**Files:**
- Modify: `noj-llm-gateway/src/providers.ts`
- Modify: `noj-llm-gateway/src/routes/internal.ts`
- Modify: `noj-llm-gateway/src/routes/llm.ts`
- Modify: `noj-llm-gateway/src/config-registry.ts`
- Modify: `noj-llm-gateway/src/db/schema.ts`
- Create: `noj-llm-gateway/drizzle/0002_remove_byok_created_by.sql`
- Modify: `noj-llm-gateway/tests/{providers_test.ts,config_registry_test.ts,helpers.ts}`

**Interfaces:**
- Consumes: 无
- Produces: `ProviderInput` / `ProviderRow` 无 `created_by`；`listProviders(db, storeKey)` 双参签名；`/internal/providers*` 无 `created_by` 过滤；`llm_providers` 表无 `created_by` 列。

- [ ] **Step 1: 先删测试用例**

在 `noj-llm-gateway/tests/providers_test.ts` 删除 `byokRow` helper（原约 103-107 行）与 3 个 BYOK 用例（拒绝 enabled / 拒绝负 cost / 白名单字段）、`BYOK base URL rejects unsafe targets` 用例及 `validateByokBaseUrl` import；保留管理员用例（`created_by=0` 更新 enabled 与 cost）。
在 `tests/config_registry_test.ts` 删除 BYOK 断言（原第 61-67 行）。
在 `tests/helpers.ts` 删除 `created_by: "0",`（原第 114 行）。

Run: `cd noj-llm-gateway && deno task test`
Expected: FAIL（生产代码仍导出 `validateByokBaseUrl` 等，或断言不再匹配）

- [ ] **Step 2: 精简 providers.ts**

在 `noj-llm-gateway/src/providers.ts` 删除 `validateByokBaseUrl`、`isPrivateHostname`、`validateByokFields`、`BYOK_UPDATABLE_FIELDS`、`isByokRow`；删除 `ProviderInput.created_by`、`ProviderRow.created_by`；`listProviders` 改为 `(db, storeKey)` 双参并删除 `created_by` WHERE；`createProvider` 删除 BYOK 校验分支与 INSERT 的 `created_by` 列/参数；`updateProvider` 删除 BYOK 白名单分支与 `validateByokBaseUrl` 分支；
`deleteProvider`、`testProviderConnection` 删除 `createdBy` 参数与归属校验。（保留 `cost_per_1k_tokens` 夹取，将注释中"用户可为全局配额退款"改为通用措辞"防止 u64 溢出与污染配额核算"。）

- [ ] **Step 3: 精简 internal 路由**

在 `noj-llm-gateway/src/routes/internal.ts`：
- `GET /internal/providers` 改为 `listProviders(deps.db, deps.config.storeKey)`，删除 `created_by` query。
- `GET /internal/providers/:id` 删除 `createdBy` 分支，统一走无过滤查询。
- `PUT /internal/providers/:id` 删除 `createdBy` 归属校验块。
- `DELETE /internal/providers/:id` 与 `POST /internal/providers/:id/test` 删除 `created_by` query 实参。

- [ ] **Step 4: 精简 llm 代理复验**

在 `noj-llm-gateway/src/routes/llm.ts` 删除：

```ts
    if (providerSecret.provider.created_by !== "0") {
      try {
        validateByokBaseUrl(providerSecret.provider.base_url);
      } catch {
        return c.json({ error: "provider_target_rejected" }, 403);
      }
    }
```
并删除 `validateByokBaseUrl` import。

- [ ] **Step 5: 删配置注册与 schema 列**

在 `noj-llm-gateway/src/config-registry.ts` 删除 `NOJ_LLM_BYOK_ALLOWED_HOSTS` 条目（原第 106-113 行）。
在 `noj-llm-gateway/src/db/schema.ts` 删除 `created_by: text("created_by").notNull().default("0"),`（原第 32 行）。

- [ ] **Step 6: 新增 gateway 迁移**

创建 `noj-llm-gateway/drizzle/0002_remove_byok_created_by.sql`：

```sql
-- 移除 BYOK：删除用户自建 Provider（含加密 Key）并删除归属列。
-- 用户 Provider 是 created_by <> '0' 的唯一来源；平台 Provider（'0'）保留。
DELETE FROM llm_providers WHERE created_by <> '0';
ALTER TABLE llm_providers DROP COLUMN IF EXISTS created_by;
```

- [ ] **Step 7: 运行测试与检查**

Run: `cd noj-llm-gateway && deno task test`
Expected: PASS

Run: `cd noj-llm-gateway && deno task check`
Expected: PASS（fmt + lint + check）

- [ ] **Step 8: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "refactor(gateway): 移除 BYOK 归属模型、出网白名单与 created_by 列"
jj new
```

---

## Task 7: UI 移除自带模型入口

**Files:**
- Modify: `noj-ui/pages/settings.vue`
- Modify: `noj-ui/components/editor/EditorWorkspace.vue`
- Modify: `noj-ui/pages/editor/[id].vue`

**Interfaces:**
- Consumes: Task 4 已删 `/me/llm-providers` 路由
- Produces: 设置页无「自带模型」区块；编辑器无模型配置下拉、提交载荷不含 `llm_provider_config_id`。

- [ ] **Step 1: 删设置页 BYOK 区块**

在 `noj-ui/pages/settings.vue` 删除 script 中 BYOK 段（`byokProviders` / `byokLoading` / `byokError` / `byokForm` / `loadByokProviders` / `createByokProvider` / `rotateByokProvider` / `deleteByokProvider` / `testByokProvider` / watch，原约 371-460 行）与 template 中「用户自带模型（BYOK）」卡片（原约 658-696 行）及 `ByokProvider` interface。

- [ ] **Step 2: 删编辑器下拉与载荷**

在 `noj-ui/components/editor/EditorWorkspace.vue` 删除 `enableByok` prop 与默认值、`ByokProvider` interface、`byokProviders` / `selectedByokProvider` / `byokLoading` / `loadByokProviders` / watch、提交载荷中的 `llm_provider_config_id`（原约 425-443 行的下拉模板块一并删除）。

- [ ] **Step 3: 删 editor 页面绑定**

在 `noj-ui/pages/editor/[id].vue` 删除 `:enable-byok="!isContest"`（原第 216 行）与载荷中的 `...(llmProviderConfigId ? { llm_provider_config_id: llmProviderConfigId } : {})`。

- [ ] **Step 4: 运行检查**

Run: `cd noj-ui && deno fmt --check && deno lint`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "refactor(ui): 移除设置页与编辑器的自带模型入口"
jj new
```

---

## Task 8: 文档与环境变量清理

**Files:**
- Delete: `noj-docs/docs/users/byok.md`
- Modify: `noj-docs/docs/users/index.md`
- Modify: `noj-docs/docs/.vitepress/config.ts`
- Modify: `noj-docs/docs/operators/production-secrets.md`
- Modify: `docker-compose.yml`、`docker-compose.e2e.yml`、`docker-compose.prod.yml`
- Modify: `.env.prod.example`、`noj-llm-gateway/.env.example`、`noj-llm-gateway/README.md`
- Modify: `noj-judge/AGENTS.md`

**Interfaces:**
- Consumes: Task 6 已删 `NOJ_LLM_BYOK_ALLOWED_HOSTS` 登记
- Produces: 全仓不再有 BYOK 文档与环境变量引用。

- [ ] **Step 1: 删文档**

删除 `noj-docs/docs/users/byok.md`；在 `users/index.md` 删除 BYOK 链接与介绍句；在 `.vitepress/config.ts` 删除导航项
`{ text: "使用自带模型（BYOK）", link: "/users/byok" }`。

- [ ] **Step 2: 清运维文档与 judge AGENTS**

在 `noj-docs/docs/operators/production-secrets.md` 删除 BYOK allowlist 段落。
在 `noj-judge/AGENTS.md` 删除 `user_llm` 描述。

- [ ] **Step 3: 清环境变量**

从以下文件删除 `NOJ_LLM_BYOK_ALLOWED_HOSTS` 行及其注释：
`docker-compose.yml`、`docker-compose.e2e.yml`、`docker-compose.prod.yml`、`.env.prod.example`、`noj-llm-gateway/.env.example`、`noj-llm-gateway/README.md` 表格行。

- [ ] **Step 4: 校验扫描无残留**

`noj-cli` 只引用保留项 `NOJ_LLM_SERVICE_TOKEN` / `NOJ_LLM_STORE_KEY`，本任务不涉及。

Run: `rg -n "BYOK|byok|NOJ_LLM_BYOK_ALLOWED_HOSTS|llm-providers|user_llm|llm_provider_config_id" --glob '!*.lock' --glob '!dev-docs/**' --glob '!.agents/**' --glob '!CHANGELOG.md' .`
Expected: 仅剩历史文档/审计/测试夹具中已明确保留或待 Task 9/10 处理的条目；生产代码零匹配。

- [ ] **Step 5: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "docs(root): 清理 BYOK 文档与环境变量"
jj new
```

---

## Task 9: 补充测试与契约快照收尾

**Files:**
- Modify: `noj-core/src/domains/submission/tests/types/judge-task-contract.test.ts`（若 Task 2 未完全清理）
- Modify: `noj-tests/fixtures/judge-task.contract.json`（若 Task 1 未完全清理）

**Interfaces:**
- Consumes: Task 1–8 的全部删除
- Produces: 两侧契约测试与 fixture 完全一致，无 `user_llm`。

- [ ] **Step 1: 契约一致性测试**

Run: `cd noj-core && deno task test:domain submission`
Expected: PASS

Run: `cd noj-judge && cargo nextest run --all-targets -E 'test(judge_task_contract)'`
Expected: PASS

- [ ] **Step 2: 跨模块 E2E**

Run: `cd noj-tests && deno task test:domain submission`
Expected: PASS

- [ ] **Step 3: 提交（如有改动）**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "test(root): 收尾 BYOK 契约快照与跨模块断言"
jj new
```

---

## Task 10: Agent Note 与全链路门禁

**Files:**
- Create: `.agents/notes/implemented/simplification/2026-09-21-remove-byok-full-path.md`

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 决策记录 + 全绿门禁。

- [ ] **Step 1: 写 Agent Note**

创建 `.agents/notes/implemented/simplification/2026-09-21-remove-byok-full-path.md`，含格式要求的 `Status: implemented` 与 `## Problem` / `## Decision` / `## Alternatives considered` / `## Consequences` 四段。内容须包含 spec §7 的重建指引：归属模型显式分离、更新路径字段白名单、精确主机 allowlist、judge 每任务调用计数上限、契约字段双侧同步。

- [ ] **Step 2: 校验 Agent Note 格式**

Run: `deno run -A scripts/verify-agent-note-format.ts`
Expected: PASS

- [ ] **Step 3: 全链路门禁**

Run: `deno run -A scripts/gate-list.ts`（或按仓库统一入口 `check-all`）
Expected: 全部 PASS，重点含 `gen-route-catalog --check`、`check-migration-snapshot-chain`、契约测试、Agent Note 格式。

Run: `cd noj-judge && cargo fmt --check && cargo clippy --all-targets -- -D warnings`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "docs(root): BYOK 移除决策记录与重建指引"
jj new
```

---

## 收尾检查（对照 spec §6 验证）

- [ ] 契约：core 与 judge 两侧字段集一致且不含 `user_llm`
- [ ] 路由目录：`gen-route-catalog --check` 通过，无 `/me/llm-providers`
- [ ] 迁移：`check-migration-snapshot-chain` 通过；存量库 `db:migrate` 成功
- [ ] gateway：管理员 Provider 用例保留并通过
- [ ] 端到端：普通提交与题目 LLM 链路不受影响；`request_user_llm_completion` 返回 `CapabilityNotFound`
- [ ] 文档：`verify-agent-note-format` 通过
- [ ] `rg` 全仓扫描：生产代码无 BYOK 残留
