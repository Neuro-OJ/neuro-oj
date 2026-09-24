# 预测提交题（本地 GPU 出分）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `prediction` 提交模式——选手在公开数据上用本地 GPU 产出预测文件，服务端在只含 Evaluator 的单容器内用隐藏标签确定性算分，结果进入正式计分/榜单。

**Architecture:** 复用既有类 Kaggle artifact 链路的骨架（对象存储列、大小上限、生命周期、契约构造），新增一条**无 Solution 容器、无 NDJSON 编排**的判分路径。隐藏判据（`hidden.jsonl`、`evaluate.py`）始终只进 Evaluator；选手提交物是纯数据（禁 pickle），平台不执行任何不可信代码。

**Tech Stack:** Deno 2 + Hono + Drizzle（noj-core）；Rust + Tokio + Bollard（noj-judge）；Python 3.12 stdlib（Evaluator SDK）；Nuxt 4 + Vue 3（noj-ui）；VitePress（noj-docs）。

**Spec:** `dev-docs/superpowers/specs/2026-09-21-local-gpu-prediction-submission-design.md`

## Global Constraints

- `submission_mode` 取值固定三值：`"code" | "artifact" | "prediction"`；数据库 CHECK 必须同步三值。
- `JudgeTask.submission_mode` 在 TS 侧**必填**；Rust 侧 `#[serde(default = "default_submission_mode")]` 缺省 `"code"`（兼容在途旧消息）。
- `RuntimeConfig.solution` 改为**可选**；**模式只由显式 `submission_mode` 判定，不靠字段缺席推断**。
- prediction **复用** `submissions.artifact_storage_url` 承载预测文件、**复用** `problems.artifact_max_size_mb` 作为大小上限；**不新增列、不新增字段**。
- prediction **不支持重测**（沿用 artifact 的拒绝逻辑，因其 `artifact_storage_url` 非空）。
- prediction **只创建 Evaluator 容器**；Solution 容器不得被创建或启动。
- 预测文件**禁止 pickle**：扩展名黑名单 + 魔数检测 + SDK 强制 `allow_pickle=False`（三层）。
- **不可动摇约束**：隐藏标签、标准答案、评分脚本不得写入选手可见响应（`output` / `details`），也不得下发到选手机器。`details.cases[]` 每项必须带布尔 `hidden`。
- 新环境变量：`JUDGE_PREDICTION_WORKSPACE_MB`（默认 `2048`，有效范围 `512..=16384`）。必须同步根 `.env.prod.example` 与 `noj-judge/AGENTS.md`。
- 新 env 变量须登记 `noj-core/src/shared/config/settings-registry.ts` 并同步 `.env.example`（`deno task check:env` 校验）。
- 所有提交**必须 GPG 签名**；提交信息格式 `<type>(<scope>): <中文描述>`，scope ∈ `core|ui|judge|root`。
- 禁止修改 `_journal.json`、`deno.lock`、`Cargo.lock`。
- 测试必须经 `deno task` / `cargo nextest`；禁止手拼 `deno test`。
- 迁移编号从 `0086_` 起；不得带 schema 前缀。

> **2026-09-22 更新（评审收尾）**：`0086` 与 BYOK 移除链（#570）的
> `0086_brainy_venus` 撞号。按仓库既有约定（对照
> `77253a736 chore(root): 同步 main 并解决社区迁移编号冲突`），本分支的迁移
> **改号为 `0087_loud_dreadnoughts`**（快照同步重命名，prevId 链保持指向 0085）。
> 两个分支各自单独合入 main 都不会破坏快照链；若两者先后合入，后合入者需按
> 合并后的 main 重跑一次 `db:generate` 口径核对（见 Agent Note）。

---

## File Structure

**noj-core（create）**
- `src/domains/submission/services/submissions/prediction-submissions.ts` —— prediction 提交服务（模式校验、单文件校验、上传、构造任务）
- `src/domains/submission/services/submissions/prediction-format.ts` —— 扩展名白名单/黑名单 + 魔数校验（纯函数，可单测）
- `drizzle/0086_*.sql` —— submission_mode CHECK 三值（`db:generate` 产出）

**noj-core（modify）**
- `src/domains/submission/types/index.ts` —— `JudgeSubmissionMode`、`JudgeTask.submission_mode`、`JUDGE_TASK_FIELDS`
- `src/domains/catalog/types/runtime-config.ts` —— `solution?`、`workspace_size_mb?`
- `src/domains/catalog/types/problems.ts` —— `SUBMISSION_MODES` 三值
- `src/domains/catalog/types/problem-bundle.ts` —— manifest 校验
- `src/domains/catalog/services/problems/problems-types.ts` —— `validateRuntimeConfig`
- `src/domains/catalog/services/problems/problems-crud.ts` —— prediction 跳过 solution 校验
- `src/domains/admin/routes/catalog.ts` —— preflight 容错可选 solution
- `src/domains/submission/services/submissions/submissions-crud.ts` —— 拒绝 prediction JSON 提交 + 补 `submission_mode`
- `src/domains/submission/services/submissions/submissions-rejudge.ts` —— 两处补 `submission_mode`
- `src/domains/submission/services/submissions/artifact-submissions.ts` —— 补 `submission_mode: "artifact"`
- `src/domains/submission/services/self-tests.ts` —— 补 `submission_mode: "code"`
- `src/domains/submission/mq/sweeper.ts` —— 行类型加 `submission_mode` + 补字段
- `src/domains/submission/routes/submissions.ts` —— multipart 分支按模式分派
- `src/domains/contest/routes/contests.ts` —— 竞赛 multipart 分支分派
- `src/domains/submission/services/submissions/submissions.ts` —— barrel 导出 prediction 服务
- `src/shared/db/schema/catalog.ts`、`src/shared/db/schema-ddl.ts` —— CHECK 三值

**noj-judge（create）**
- `src/prediction/mod.rs` —— 单容器数据评分路径
- `sdk/evaluator/noj_evaluator_sdk/prediction.py` —— 预测加载 + 对齐校验 + 度量
- `sdk/evaluator/noj_evaluator_sdk/tests/test_prediction.py` —— SDK 单测
- `src/prediction/tests.rs` 或 `tests/prediction_units.rs` —— 纯逻辑单测（不入 Docker）
- `tests/e2e_prediction.rs` —— Docker E2E

**noj-judge（modify）**
- `src/types.rs` —— `submission_mode`、`Option<SolutionRuntime>`、`workspace_size_mb`
- `src/config.rs` —— `prediction_workspace_mb` + 常量 + Debug
- `src/dual/container.rs` —— 参数化 workspace 大小 + 提升可见性
- `src/dual/mod.rs` —— 可选 solution 适配 + 提升复用函数可见性 + 流式注入原语
- `src/judge/runner.rs` —— 按 `submission_mode` 分派 + 提升下载函数可见性
- `src/lib.rs`、`src/main.rs` —— 声明 `prediction` 模块
- `sdk/evaluator/noj_evaluator_sdk/__init__.py` —— 导出 prediction

**noj-ui（modify）**
- `components/editor/CodingProblemEditor.vue` —— 模式第三项
- `pages/editor/[id].vue`、`pages/problems/[id].vue`、`pages/contests/[contestId]/problems/[label].vue` —— 单文件上传入口
- `utils/problemView.ts` —— 模式文案/判定

**noj-docs（create/modify）**
- create `docs/problemsetters/prediction-problems.md`
- modify `docs/users/submit.md`、`docs/standards/test-data.md`、`docs/mechanisms/runtimes.md`、`docs/.vitepress/config.ts`

**root（create/modify）**
- `.agents/notes/implemented/feature/2026-09-21-local-gpu-prediction-submission.md`
- `.env.prod.example`、`noj-judge/AGENTS.md`
- `noj-tests/e2e/submission/prediction_submission.test.ts`
- `noj-tests/fixtures/judge-task.contract.json`

---

### Task 1: 契约层 `submission_mode` + 可选 `solution`

**Files:**
- Modify: `noj-core/src/domains/submission/types/index.ts`
- Modify: `noj-core/src/domains/catalog/types/runtime-config.ts`
- Modify: `noj-judge/src/types.rs`
- Modify: `noj-tests/fixtures/judge-task.contract.json`
- Test: `noj-core/src/domains/submission/tests/types/judge-task-contract.test.ts`
- Test: `noj-judge/tests/judge_task_contract.rs`

**Interfaces:**
- Produces: `JudgeSubmissionMode = "code" | "artifact" | "prediction"`；`JudgeTask.submission_mode: JudgeSubmissionMode`；`RuntimeConfig.solution?: SolutionRuntime`；`EvaluatorRuntime.workspace_size_mb?: number`；Rust `JudgeTask.submission_mode: String`（默认 `"code"`）、`RuntimeConfig.solution: Option<SolutionRuntime>`、`EvaluatorRuntime.workspace_size_mb: Option<u64>`。

> ⚠️ 本任务必须**先改 TS 侧全部调用点**（Task 2 一并做），否则 `deno check` 会因必填字段缺失而失败。执行时把 Task 1 与 Task 2 放在同一提交。

- [ ] **Step 1: 写失败测试（TS 契约）**

在 `judge-task-contract.test.ts` 的三处 `buildJudgeTask({...})` 调用中加入 `submission_mode: "artifact"`，并在字段集合断言中加入 `"submission_mode"`：

```ts
// 测试 3 必填字段集合断言
assertEquals(Object.keys(built).sort(), [
  "code",
  "language",
  "priority",
  "problem_id",
  "runtime_config",
  "submission_id",
  "submission_mode",
  "user_id",
]);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain submission`
Expected: FAIL / 类型错误——`submission_mode` 未知属性、`JUDGE_TASK_FIELDS` 不含该项。

- [ ] **Step 3: 改 TS 类型（`types/index.ts`）**

```ts
/** JudgeTask 的提交模式（与题目 submission_mode 对应）。 */
export type JudgeSubmissionMode = "code" | "artifact" | "prediction";

export interface JudgeTask {
  // ...既有字段...
  /** 提交模式（服务端推导，客户端不可声明） */
  submission_mode: JudgeSubmissionMode;
}

export interface BuildJudgeTaskInput {
  // ...既有字段...
  submission_mode: JudgeSubmissionMode;
}

export function buildJudgeTask(input: BuildJudgeTaskInput): JudgeTask {
  const task: JudgeTask = {
    submission_id: input.submission_id,
    problem_id: input.problem_id,
    user_id: input.user_id,
    priority: input.priority,
    submission_mode: input.submission_mode,
    runtime_config: input.runtime_config,
    language: input.language,
    code: input.code,
  };
  // ...余下 if 分支不变...
}

export const JUDGE_TASK_FIELDS: readonly string[] = [
  "submission_id",
  "problem_id",
  "user_id",
  "priority",
  "submission_mode",
  "runtime_config",
  "download_url",
  "artifact_download_url",
  "language",
  "code",
  "file_name",
  "rejudge_seq",
  "llm",
  "user_llm",
];
```

- [ ] **Step 4: 改 TS runtime-config**

`noj-core/src/domains/catalog/types/runtime-config.ts`：

```ts
export interface EvaluatorRuntime {
  image: string;
  command: string;
  time_limit_ms: number;
  memory_limit_mb: number;
  network?: { enabled: boolean };
  /** prediction 模式 /workspace tmpfs 上限（MB）；缺省用 judge 的 JUDGE_PREDICTION_WORKSPACE_MB */
  workspace_size_mb?: number;
}

/** 双容器模式的 Runtime 配置。prediction 模式省略 solution（不创建 Solution 容器）。 */
export interface RuntimeConfig {
  evaluator: EvaluatorRuntime;
  solution?: SolutionRuntime;
}
```

- [ ] **Step 5: 改 Rust 结构体（`types.rs`）**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeConfig {
    pub evaluator: EvaluatorRuntime,
    /// prediction 模式省略（无 Solution 容器）。
    #[serde(default)]
    pub solution: Option<SolutionRuntime>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluatorRuntime {
    pub image: String,
    pub command: String,
    pub time_limit_ms: u64,
    pub memory_limit_mb: u64,
    #[serde(default)]
    pub network: Option<EvaluatorNetwork>,
    /// prediction 模式 /workspace 上限（MB）。
    #[serde(default)]
    pub workspace_size_mb: Option<u64>,
}

pub struct JudgeTask {
    // ...既有字段...
    /// 提交模式；缺省 "code"（兼容在途旧消息）。
    #[serde(default = "default_submission_mode")]
    pub submission_mode: String,
}

fn default_submission_mode() -> String {
    "code".to_string()
}
```

- [ ] **Step 6: 更新 fixture 与 Rust 契约测试**

`noj-tests/fixtures/judge-task.contract.json` 顶层加：

```json
"submission_mode": "artifact",
```

`noj-judge/tests/judge_task_contract.rs`：期望字段数组加 `"submission_mode"`；`judge_task_contract_fixture_deserializes` 加断言：

```rust
assert_eq!(task.submission_mode, "artifact");
// solution 现为 Option：
assert_eq!(task.runtime_config.solution.as_ref().unwrap().image, "noj-solution-python");
```

- [ ] **Step 7: 运行两侧契约测试**

Run: `cd noj-core && deno task test:domain submission`
Run: `cd noj-judge && cargo nextest run --all-targets judge_task_contract`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add noj-core/src/domains/submission/types/index.ts \
  noj-core/src/domains/catalog/types/runtime-config.ts \
  noj-judge/src/types.rs noj-tests/fixtures/judge-task.contract.json \
  noj-core/src/domains/submission/tests/types/judge-task-contract.test.ts \
  noj-judge/tests/judge_task_contract.rs
git commit -S -m "feat(core,judge): JudgeTask 新增 submission_mode 并放开 solution 可选"
```

---

### Task 2: core 全部 `buildJudgeTask` 调用点补字段

**Files:**
- Modify: `noj-core/src/domains/submission/services/submissions/submissions-crud.ts:376,476`
- Modify: `noj-core/src/domains/submission/services/submissions/submissions-rejudge.ts:159,378`
- Modify: `noj-core/src/domains/submission/services/submissions/artifact-submissions.ts:306`
- Modify: `noj-core/src/domains/submission/services/self-tests.ts:142`
- Modify: `noj-core/src/domains/submission/mq/sweeper.ts:277`

**Interfaces:**
- Consumes: `JudgeSubmissionMode`（Task 1）
- Produces: 每个调用点显式声明自身模式；prediction 题被 JSON 代码提交路径拒绝。

- [ ] **Step 1: 写失败测试**

在 `noj-core/src/domains/submission/tests/services/submissions.test.ts` 加：

```ts
Deno.test("submission: prediction 题目拒绝 JSON 代码提交", async () => {
  // 前置：创建 submission_mode='prediction' 的题目（复用现有测试建题辅助）
  // 断言：POST /api/v1/submissions（JSON）返回 400，错误信息含 "预测"
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd noj-core && deno task test:domain submission`
Expected: FAIL（当前 prediction 题会走 code 路径）

- [ ] **Step 3: 拒绝 prediction 的 JSON 提交（`submissions-crud.ts`）**

替换第 375-378 行：

```ts
  // artifact / prediction 题目必须走 multipart 上传，拒绝 JSON 代码提交
  if (problem.submission_mode === "artifact" || problem.submission_mode === "prediction") {
    throw new BadRequestError(
      problem.submission_mode === "artifact"
        ? "该题目要求上传 zip 产物"
        : "该题目要求上传预测结果文件",
    );
  }
```

并在第 476 行附近的 `buildJudgeTask({...})` 加 `submission_mode: "code"`。

- [ ] **Step 4: 重测两处按源推导**

`submissions-rejudge.ts` 两处 `buildJudgeTask` 加（两处同构）：

```ts
    submission_mode: (problem.submission_mode as JudgeSubmissionMode) ?? "code",
```

并在文件顶部补 `import type { JudgeSubmissionMode } from "../../types/index.ts";`（若 barrel 路径不同，按既有 import 风格）。

- [ ] **Step 5: 其余三处**

- `artifact-submissions.ts:306` 加 `submission_mode: "artifact"`。
- `self-tests.ts:142` 加 `submission_mode: "code"`。
- `sweeper.ts`：在 `PendingRecoveryRow` 与 `selectPendingRecoveryRows` 的 select 中增加 `submission_mode: problems.submission_mode`；在 `buildJudgeTask` 加

```ts
      submission_mode: source === "self_test"
        ? "code"
        : (row.submission_mode as JudgeSubmissionMode) ?? "code",
```

- [ ] **Step 6: 运行测试**

Run: `cd noj-core && deno task test:domain submission`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add -A noj-core/src/domains/submission
git commit -S -m "feat(core): 全部 JudgeTask 构造点声明 submission_mode"
```

---

### Task 3: catalog 题目校验支持 prediction

**Files:**
- Modify: `noj-core/src/domains/catalog/types/problems.ts:76`
- Modify: `noj-core/src/domains/catalog/services/problems/problems-types.ts:105`
- Modify: `noj-core/src/domains/catalog/types/problem-bundle.ts:216,277,519`
- Modify: `noj-core/src/domains/catalog/services/problems/problems-crud.ts:143,410`
- Modify: `noj-core/src/domains/admin/routes/catalog.ts:104`
- Test: `noj-core/src/domains/catalog/tests/services/problems-types.test.ts`

**Interfaces:**
- Produces: `SUBMISSION_MODES = ["code","artifact","prediction"]`；`validateRuntimeConfig(rc, submissionMode?)` 在 prediction 下允许省略 solution。

- [ ] **Step 1: 写失败测试**

在 `problems-types.test.ts` 加：

```ts
Deno.test("problems-types: prediction 模式允许省略 runtime_config.solution", () => {
  validateRuntimeConfig(
    { evaluator: { image: "noj-evaluator-python", command: "python3 /workspace/evaluate.py", time_limit_ms: 5000, memory_limit_mb: 256 } },
    "prediction",
  );
});

Deno.test("problems-types: code 模式仍要求 runtime_config.solution", () => {
  assertThrows(
    () => validateRuntimeConfig({ evaluator: { image: "x", command: "python3", time_limit_ms: 1, memory_limit_mb: 1 } }, "code"),
    BadRequestError,
  );
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd noj-core && deno task test:domain catalog`
Expected: FAIL

- [ ] **Step 3: 扩枚举**

`problems.ts:76`：

```ts
export const SUBMISSION_MODES = ["code", "artifact", "prediction"] as const;
```

- [ ] **Step 4: `validateRuntimeConfig` 增加模式参数**

签名改为 `export function validateRuntimeConfig(rc: RuntimeConfig, submissionMode: SubmissionMode = "code"): void`；把现有的 `solution` 必填校验与字段校验放入 `if (submissionMode !== "prediction") { ... }` 分支（prediction 下若显式提供 solution 也照常校验）；新增可选 `workspace_size_mb` 正整数校验：

```ts
  if (evaluator.workspace_size_mb !== undefined) {
    if (typeof evaluator.workspace_size_mb !== "number" || !Number.isInteger(evaluator.workspace_size_mb) || evaluator.workspace_size_mb <= 0) {
      throw new BadRequestError("runtime_config.evaluator.workspace_size_mb 必须为正整数");
    }
  }
```

- [ ] **Step 5: 更新调用方**

- `problem-bundle.ts:277` 调 `validateRuntimeConfig(runtimeConfig, (m.submission_mode as SubmissionMode) ?? "code")`；第 519 行的 `manifest.runtime_config!.solution.image` 改为 `if (manifest.runtime_config!.solution) { await validate...solution.image... }`。
- `problems-crud.ts:136` 与 `:404` 传 `input.submission_mode`；`:143` 与 `:410` 的 `solution.image` 校验加 `if (runtimeConfig.solution)` 守卫。
- `admin/routes/catalog.ts:104` 的 preflight 遍历改为 `if (runtimeConfig.solution) { ... }`。
- `problem-bundle.ts:216` 错误文案更新为 `code / artifact / prediction`。

- [ ] **Step 6: 运行测试**

Run: `cd noj-core && deno task test:domain catalog`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add -A noj-core/src/domains/catalog noj-core/src/domains/admin
git commit -S -m "feat(core): 题目校验支持 prediction 模式与可选 solution"
```

---

### Task 4: schema CHECK 三值 + 迁移 0086

**Files:**
- Modify: `noj-core/src/shared/db/schema/catalog.ts:64`
- Modify: `noj-core/src/shared/db/schema-ddl.ts:76`
- Create: `noj-core/drizzle/0086_*.sql`（`db:generate`）

- [ ] **Step 1: 写失败测试**

在 `noj-core/src/domains/catalog/tests/services/problems.test.ts` 加：创建 `submission_mode: "prediction"` 题目应成功；创建 `submission_mode: "bogus"` 应失败（CHECK 拒绝）。

- [ ] **Step 2: 运行确认失败**

Run: `cd noj-core && deno task test:domain catalog`
Expected: FAIL（CHECK 仅允许两值）

- [ ] **Step 3: 改 schema 与 DDL**

`catalog.ts:64-67`：

```ts
    submissionModeCheck: check(
      "problems_submission_mode_check",
      sql`${table.submission_mode} IN ('code', 'artifact', 'prediction')`,
    ),
```

`schema-ddl.ts:76-77`：

```sql
    submission_mode TEXT NOT NULL DEFAULT 'code'
      CHECK (submission_mode IN ('code', 'artifact', 'prediction')),
```

- [ ] **Step 4: 生成迁移**

Run: `cd noj-core && deno task db:generate`
Expected: 生成 `drizzle/0086_*.sql`，内容为 `DROP CONSTRAINT` + `ADD CONSTRAINT`（含三值）。**不要手改 `_journal.json`**。

- [ ] **Step 5: 在存量库验证迁移**

Run: `cd noj-core && deno task db:migrate`
Expected: 成功（DROP/ADD CHECK 不触达 `check-migration-safety` 的 NOT NULL 禁令）。

- [ ] **Step 6: 门禁**

Run: `deno run -A scripts/check-migration-safety.ts && deno run -A scripts/check-migration-snapshot-chain.ts`
Expected: 均通过

- [ ] **Step 7: 运行测试 + 提交**

Run: `cd noj-core && deno task test:domain catalog`
```bash
git add noj-core/src/shared/db/schema/catalog.ts noj-core/src/shared/db/schema-ddl.ts noj-core/drizzle
git commit -S -m "feat(core): problems.submission_mode 约束扩展为三值"
```

---

### Task 5: judge 配置 `JUDGE_PREDICTION_WORKSPACE_MB`

**Files:**
- Modify: `noj-judge/src/config.rs`
- Test: `noj-judge/src/config.rs`（内联 `#[cfg(test)]`）

**Interfaces:**
- Produces: `Config.prediction_workspace_mb: u64`；`DEFAULT_PREDICTION_WORKSPACE_MB = 2048`；`MIN_..=512`、`MAX_..=16384`。

- [ ] **Step 1: 写失败测试**

在 `config.rs` 的 tests 中加：

```rust
#[test]
fn test_prediction_workspace_default_and_custom() {
    let mut guard = EnvGuard::new(&["JUDGE_PREDICTION_WORKSPACE_MB"]);
    let cfg = Config::from_env();
    assert_eq!(cfg.prediction_workspace_mb, DEFAULT_PREDICTION_WORKSPACE_MB);
    guard.set("JUDGE_PREDICTION_WORKSPACE_MB", "4096");
    let cfg = Config::from_env();
    assert_eq!(cfg.prediction_workspace_mb, 4096);
}
```

（复用文件中既有的 `ENV_TEST_MUTEX` / `EnvGuard` 模式。）

- [ ] **Step 2: 运行确认失败**

Run: `cd noj-judge && cargo nextest run --all-targets config`
Expected: 编译失败（字段不存在）

- [ ] **Step 3: 加常量、字段、读取、Debug**

```rust
/// prediction 单容器路径 /workspace tmpfs 上限（MB，默认: 2048）
pub prediction_workspace_mb: u64,
// ...
pub const DEFAULT_PREDICTION_WORKSPACE_MB: u64 = 2048;
pub const MIN_PREDICTION_WORKSPACE_MB: u64 = 512;
pub const MAX_PREDICTION_WORKSPACE_MB: u64 = 16384;
// from_env:
prediction_workspace_mb: env_var_parse::<u64>("JUDGE_PREDICTION_WORKSPACE_MB")
    .filter(|v| (MIN_PREDICTION_WORKSPACE_MB..=MAX_PREDICTION_WORKSPACE_MB).contains(v))
    .unwrap_or(DEFAULT_PREDICTION_WORKSPACE_MB),
// Debug impl:
.field("prediction_workspace_mb", &self.prediction_workspace_mb)
```

- [ ] **Step 4: 运行测试**

Run: `cd noj-judge && cargo nextest run --all-targets config`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add noj-judge/src/config.rs
git commit -S -m "feat(judge): 新增 JUDGE_PREDICTION_WORKSPACE_MB 配置"
```

---

### Task 6: judge 容器层 workspace 参数化 + 可见性提升

**Files:**
- Modify: `noj-judge/src/dual/container.rs`
- Modify: `noj-judge/src/dual/mod.rs`

**Interfaces:**
- Produces: `DualContainer::create_evaluator_with_workspace(..., workspace_mb: u64)`；`create_container_with_security(..., workspace_mb)`；`pub(crate) inject_support_package_to_evaluator`、`pub(crate) build_judge_result`、`pub(crate) clamp_runtime_config`、`pub(crate) validate_runtime_config`、`pub(crate) read_container_memory_peak_kb`、`pub const DEFAULT_WORKSPACE_MB: u64 = 512`。
- Consumes: `RuntimeConfig.solution: Option<SolutionRuntime>`（Task 1）

- [ ] **Step 1: 写失败测试**

在 `noj-judge/src/dual/container.rs` 内联测试加：

```rust
#[test]
fn test_workspace_tmpfs_string() {
    // 纯函数：把 MB 转成 tmpfs 规格字符串
    assert_eq!(workspace_tmpfs_spec(2048), "size=2048M,mode=1777");
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd noj-judge && cargo nextest run --all-targets`
Expected: 编译失败

- [ ] **Step 3: 参数化 workspace**

`container.rs`：

```rust
/// 默认 /workspace tmpfs 上限（MB）——双容器路径沿用历史值。
pub const DEFAULT_WORKSPACE_MB: u64 = 512;

/// 生成 /workspace tmpfs 规格（纯函数，便于单测）。
fn workspace_tmpfs_spec(workspace_mb: u64) -> String {
    format!("size={}M,mode=1777", workspace_mb)
}

pub async fn create_evaluator(docker: &Docker, image: &str, memory_mb: u64, network_mode: &str, cpu_limit_millicores: u64) -> Result<Self> {
    Self::create_evaluator_with_workspace(docker, image, memory_mb, network_mode, cpu_limit_millicores, DEFAULT_WORKSPACE_MB).await
}

pub async fn create_evaluator_with_workspace(docker: &Docker, image: &str, memory_mb: u64, network_mode: &str, cpu_limit_millicores: u64, workspace_mb: u64) -> Result<Self> {
    let id = create_container_with_security(docker, image, memory_mb, "evaluator", network_mode, cpu_limit_millicores, workspace_mb).await?;
    // ...同原实现...
}
```

`create_solution` 调 `create_container_with_security(..., DEFAULT_WORKSPACE_MB)`；`create_container_with_security` 签名尾部加 `workspace_mb: u64`，并把 `tmpfs.insert("/workspace", "size=512M,mode=1777")` 改为：

```rust
    tmpfs.insert("/workspace", workspace_tmpfs_spec(workspace_mb).as_str());
```

- [ ] **Step 4: 适配可选 solution 并提升可见性（`dual/mod.rs`）**

- `clamp_runtime_config`：把 solution 段包进 `if let Some(ref mut sol) = clamped.solution`。
- `validate_runtime_config`：solution 镜像校验包进 `if let Some(ref sol) = runtime_config.solution`。
- `evaluate_dual_with_cpu_limit_and_user_llm`：在函数体顶部加断言

```rust
    let solution = runtime_config
        .solution
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("submission {}: 双容器路径缺少 solution 配置", task_submission_id))?;
```

后续 `runtime_config.solution.*` 改为 `solution.*`。
- 可见性：`pub(crate) async fn inject_support_package_to_evaluator`、`pub(crate) fn build_judge_result`、`pub(crate) fn clamp_runtime_config`、`pub(crate) fn validate_runtime_config`、`pub(crate) async fn read_container_memory_peak_kb`。

- [ ] **Step 5: 编译与测试**

Run: `cd noj-judge && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo nextest run --all-targets`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add noj-judge/src/dual
git commit -S -m "refactor(judge): workspace 上限参数化并放开 solution 可选"
```

---

### Task 7: judge 单文件流式注入原语

**Files:**
- Modify: `noj-judge/src/dual/mod.rs`
- Test: `noj-judge/src/dual/mod.rs`（内联单测，纯逻辑部分）

**Interfaces:**
- Produces: `pub(crate) async fn inject_file_stream_to_container(docker, container_id, host_path: &Path, container_rel_path: &str) -> Result<()>`——边读边写，不整文件读入内存；`container_rel_path` 支持 `dir/file`。

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn test_sanitize_rel_path_rejects_traversal() {
    assert!(sanitize_rel_path("prediction/pred.csv").is_ok());
    assert_eq!(sanitize_rel_path("prediction/pred.csv").unwrap(), "prediction/pred.csv");
    assert!(sanitize_rel_path("../etc/passwd").is_err());
    assert!(sanitize_rel_path("pred/../../x").is_err());
    assert!(sanitize_rel_path("/abs").is_err());
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd noj-judge && cargo nextest run --all-targets`
Expected: 编译失败

- [ ] **Step 3: 实现纯函数 + 流式注入**

```rust
/// 校验注入用的容器内相对路径（拒绝绝对路径与 `..` 段）。
fn sanitize_rel_path(rel: &str) -> Result<String> {
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\0') {
        anyhow::bail!("非法注入路径: {}", rel);
    }
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            anyhow::bail!("非法注入路径: {}", rel);
        }
    }
    Ok(rel.to_string())
}

/// 流式注入宿主文件到容器（边读边写 tar，不整文件读入内存）。
pub(crate) async fn inject_file_stream_to_container(
    docker: &bollard::Docker,
    container_id: &str,
    host_path: &Path,
    container_rel_path: &str,
) -> Result<()> {
    let rel = sanitize_rel_path(container_rel_path)?;
    let file = tokio::fs::File::open(host_path).await
        .context("打开待注入文件失败")?;
    let size = file.metadata().await.context("读取文件元数据失败")?.len();

    let exec = docker.create_exec(container_id, bollard::models::ExecConfig {
        cmd: Some(vec!["sh".into(), "-c".into(), "tar xf - -C /workspace".into()]),
        attach_stdin: Some(true),
        attach_stdout: Some(false),
        attach_stderr: Some(false),
        ..Default::default()
    }).await.context("创建注入 exec 失败")?;

    let started = docker.start_exec(&exec.id, None).await?;
    if let bollard::exec::StartExecResults::Attached { mut input, .. } = started {
        let mut header = tar::Header::new_gnu();
        header.set_size(size);
        header.set_mode(0o644);
        header.set_cksum();
        let mut builder = tar::Builder::new(&mut input);
        builder.append_data(&mut header, &rel, file).await
            .context("流式写入 tar 失败")?;
        builder.finish().context("收尾 tar 失败")?;
        input.shutdown().await.context("关闭注入 stdin 失败")?;
    }

    for _ in 0..INJECT_POLL_ATTEMPTS {
        let inspect = docker.inspect_exec(&exec.id).await?;
        if let Some(code) = inspect.exit_code {
            if code != 0 {
                anyhow::bail!("注入文件 {} 失败（exit_code={}）", rel, code);
            }
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(INJECT_POLL_INTERVAL_MS)).await;
    }
    anyhow::bail!("注入文件超时")
}
```

> 若 `tar::Builder<&mut Pin<Box<dyn AsyncWrite>>>` 不满足 `std::io::Write`，改为：先在 `spawn_blocking` 中把 tar 帧写入一个 `tokio::io::DuplexStream`/管道，再 `tokio::io::copy` 到 `input`。执行者需以实际编译为准，保持「不把整文件读入内存」这一硬约束。

- [ ] **Step 4: 运行测试与 clippy**

Run: `cd noj-judge && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo nextest run --all-targets`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add noj-judge/src/dual/mod.rs
git commit -S -m "feat(judge): 新增单文件流式注入原语"
```

---

### Task 8: judge prediction 单容器路径

**Files:**
- Create: `noj-judge/src/prediction/mod.rs`
- Test: `noj-judge/src/prediction/mod.rs`（内联纯逻辑单测）

**Interfaces:**
- Consumes: Task 5/6/7 的配置、容器、注入原语；`crate::dual::{build_judge_result, clamp_runtime_config, validate_runtime_config, inject_support_package_to_evaluator, read_container_memory_peak_kb}`、`crate::dual::container::{DualContainer, start_exec}`。
- Produces: `pub async fn evaluate_prediction(docker, submission_id, runtime_config, support_pkg_path, prediction_path, prediction_file_name, rejudge_seq, cpu_limit_millicores, allow_evaluator_network, evaluator_network_mode, image_prefix, command_whitelist, max_evaluator_time_ms, default_workspace_mb) -> Result<JudgeResult>`。

- [ ] **Step 1: 写失败测试（纯逻辑）**

```rust
#[cfg(test)]
mod tests {
    use super::extract_result_payload;

    #[test]
    fn test_extract_result_payload() {
        let out = "some logs\n---RESULT---\n{\"score\":1000,\"details\":{}}\ntrailing";
        assert_eq!(extract_result_payload(out).as_deref(), Some("{\"score\":1000,\"details\":{}}"));
        assert_eq!(extract_result_payload("no marker here"), None);
        assert_eq!(extract_result_payload("---RESULT---\n\n  \n"), None);
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd noj-judge && cargo nextest run --all-targets`
Expected: 编译失败（模块不存在）

- [ ] **Step 3: 实现模块**

```rust
//! prediction 模式：单容器数据评分路径。
//!
//! **不创建、不执行 Solution 容器**，无 NDJSON 编排。选手提交物是纯数据，
//! 平台不执行任何不可信代码。

use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use bollard::container::LogOutput;
use futures_util::StreamExt;
use serde_json::Value;
use tracing::warn;

use crate::dual::container::{start_exec, DualContainer};
use crate::types::{JudgeResult, RuntimeConfig};

const PREDICTION_DIR: &str = "/workspace/prediction";
const RESULT_MARKER: &str = "---RESULT---";

/// 从 evaluator stdout 提取 `---RESULT---` 后的首个非空行。
fn extract_result_payload(stdout: &str) -> Option<String> {
    let mut lines = stdout.lines();
    while let Some(line) = lines.next() {
        if line.trim() == RESULT_MARKER {
            for next in lines.by_ref() {
                if !next.trim().is_empty() {
                    return Some(next.trim().to_string());
                }
            }
            return None;
        }
    }
    None
}

/// prediction 评测入口。
#[allow(clippy::too_many_arguments)]
pub async fn evaluate_prediction(
    docker: bollard::Docker,
    submission_id: &str,
    runtime_config: &RuntimeConfig,
    support_pkg_path: Option<&Path>,
    prediction_path: &Path,
    prediction_file_name: &str,
    rejudge_seq: Option<i64>,
    cpu_limit_millicores: u64,
    allow_evaluator_network: bool,
    evaluator_network_mode: &str,
    image_prefix: &str,
    command_whitelist: &[String],
    max_evaluator_time_ms: u64,
    default_workspace_mb: u64,
) -> Result<JudgeResult> {
    // 复用双容器路径的同名 clamp/validate（solution 为 None 时自动跳过其校验）
    let rc = crate::dual::clamp_runtime_config_for_prediction(runtime_config, max_evaluator_time_ms);
    crate::dual::validate_runtime_config(submission_id, &rc, allow_evaluator_network, image_prefix, command_whitelist)?;

    let started = Instant::now();
    let startup_deadline = Instant::now() + Duration::from_secs(30);

    let network_enabled = rc.evaluator.network.as_ref().map(|n| n.enabled).unwrap_or(false);
    let network_mode = if network_enabled { evaluator_network_mode } else { "none" };
    let workspace_mb = rc.evaluator.workspace_size_mb.unwrap_or(default_workspace_mb);

    let mut dual = DualContainer::create_evaluator_with_workspace(
        &docker,
        &rc.evaluator.image,
        rc.evaluator.memory_limit_mb,
        network_mode,
        cpu_limit_millicores,
        workspace_mb,
    )
    .await
    .context("创建 Evaluator 容器失败")?;

    let evaluator_id = dual
        .evaluator_id
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Evaluator 容器 ID 缺失"))?;

    if let Some(pkg) = support_pkg_path {
        crate::dual::inject_support_package_to_evaluator(&docker, &evaluator_id, pkg)
            .await
            .context("注入支持包到 Evaluator 容器失败")?;
    }

    // 预测文件 → /workspace/prediction/<file_name>
    let rel = format!("prediction/{}", prediction_file_name);
    crate::dual::inject_file_stream_to_container(&docker, &evaluator_id, prediction_path, &rel)
        .await
        .context("注入预测文件失败")?;

    let env = vec![
        format!("NOJ_PREDICTION_DIR={}", PREDICTION_DIR),
        format!("NOJ_PREDICTION_FILE={}", prediction_file_name),
    ];
    let cmd = crate::sandbox::container::parse_command(&rc.evaluator.command);
    let exec = start_exec(&docker, &evaluator_id, cmd, env)
        .await
        .context("启动 Evaluator exec 失败")?;

    let outcome = run_prediction_loop(
        submission_id,
        exec,
        rc.evaluator.time_limit_ms,
        rejudge_seq,
        startup_deadline,
    )
    .await;

    let memory_peak_kb =
        crate::dual::read_container_memory_peak_kb(&docker, &evaluator_id).await;
    if let Err(e) = dual.destroy().await {
        warn!("prediction 容器销毁警告: {}", e);
    }

    let mut result = outcome?;
    if result.time_ms.is_none() {
        result.time_ms = Some(started.elapsed().as_millis() as u64);
    }
    if result.memory_kb.is_none() {
        result.memory_kb = memory_peak_kb;
    }
    Ok(result)
}

async fn run_prediction_loop(
    submission_id: &str,
    mut exec: crate::dual::container::ExecSession,
    time_limit_ms: u64,
    rejudge_seq: Option<i64>,
    startup_deadline: Instant,
) -> Result<JudgeResult> {
    let mut stdout_full = String::new();
    let mut stderr_buf = String::new();

    // 阶段 1：等待首条输出（30s 启动期）
    let mut first_seen = false;
    while !first_seen {
        let remaining = startup_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(JudgeResult::system_error(submission_id, "评测程序启动超时", rejudge_seq));
        }
        match tokio::time::timeout(remaining, exec.output.next()).await {
            Err(_) => return Ok(JudgeResult::system_error(submission_id, "评测程序启动超时", rejudge_seq)),
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(anyhow::anyhow!("读取 Evaluator 输出失败: {}", e)),
            Ok(Some(Ok(chunk))) => {
                first_seen = true;
                append_chunk(&chunk, &mut stdout_full, &mut stderr_buf);
            }
        }
    }

    // 阶段 2：总时限内持续读取
    let deadline = Instant::now() + Duration::from_millis(time_limit_ms);
    loop {
        if extract_result_payload(&stdout_full).is_some() {
            break;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(JudgeResult::system_error(submission_id, "评测超时（time_limit_ms）", rejudge_seq));
        }
        match tokio::time::timeout(remaining, exec.output.next()).await {
            Err(_) => return Ok(JudgeResult::system_error(submission_id, "评测超时（time_limit_ms）", rejudge_seq)),
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(anyhow::anyhow!("读取 Evaluator 输出失败: {}", e)),
            Ok(Some(Ok(chunk))) => append_chunk(&chunk, &mut stdout_full, &mut stderr_buf),
        }
    }

    match extract_result_payload(&stdout_full) {
        Some(payload) => match serde_json::from_str::<Value>(&payload) {
            Ok(parsed) => Ok(crate::dual::build_judge_result(submission_id, &parsed, &stderr_buf, &stdout_full, rejudge_seq)),
            Err(e) => {
                warn!("prediction RESULT JSON 解析失败: {}", e);
                Ok(JudgeResult::system_error(submission_id, "评测脚本输出结果不是合法 JSON", rejudge_seq))
            }
        },
        None => Ok(JudgeResult::system_error(submission_id, "评测脚本未输出结果标记", rejudge_seq)),
    }
}

fn append_chunk(chunk: &LogOutput, stdout_full: &mut String, stderr_buf: &mut String) {
    match chunk {
        LogOutput::StdOut { message } => {
            stdout_full.push_str(&String::from_utf8_lossy(message));
        }
        LogOutput::StdErr { message } => {
            stderr_buf.push_str(&String::from_utf8_lossy(message));
        }
        _ => {}
    }
}
```

- [ ] **Step 4: 在 `dual/mod.rs` 补 prediction 专用 clamp**

`clamp_runtime_config` 已可处理 `Option`（Task 6），prediction 复用即可；为语义清晰新增委托：

```rust
/// prediction 路径的运行时收敛（不涉及 solution 调用超时）。
pub(crate) fn clamp_runtime_config_for_prediction(rc: &RuntimeConfig, max_evaluator_time_ms: u64) -> RuntimeConfig {
    let mut c = rc.clone();
    if max_evaluator_time_ms > 0 {
        c.evaluator.time_limit_ms = c.evaluator.time_limit_ms.min(max_evaluator_time_ms);
    }
    c.evaluator.memory_limit_mb = c.evaluator.memory_limit_mb.min(4096);
    c
}
```

- [ ] **Step 5: 编译、clippy、单测**

Run: `cd noj-judge && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo nextest run --all-targets`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add noj-judge/src/prediction noj-judge/src/dual/mod.rs
git commit -S -m "feat(judge): 新增 prediction 单容器评分路径"
```

---

### Task 9: judge 分派 + 模块声明

**Files:**
- Modify: `noj-judge/src/judge/runner.rs:106`
- Modify: `noj-judge/src/lib.rs:5`
- Modify: `noj-judge/src/main.rs:5`

**Interfaces:**
- Consumes: `prediction::evaluate_prediction`（Task 8）
- Produces: `evaluate_with_cpu_limit` 依据 `task.submission_mode` 分派；新增参数 `prediction_workspace_mb: u64`、`evaluator_file_name: Option<&str>`（用 `task.file_name`）。

- [ ] **Step 1: 写失败测试**

在 `noj-judge/tests/judge_task_contract.rs` 或新 `tests/prediction_units.rs` 加：`dispatch_target("prediction") == Target::Prediction`，`dispatch_target("code") == Target::Dual`。将分派判定抽成纯函数以便测试。

- [ ] **Step 2: 运行确认失败**

Run: `cd noj-judge && cargo nextest run --all-targets`
Expected: 编译失败

- [ ] **Step 3: 抽分派纯函数并接入**

`runner.rs`：

```rust
/// 评测路径选择（纯函数，便于单测）。
pub fn is_prediction_mode(submission_mode: &str) -> bool {
    submission_mode == "prediction"
}
```

在下载支持包/预测文件之后：

```rust
    if is_prediction_mode(&task.submission_mode) {
        let prediction_path = artifact_zip
            .as_ref()
            .map(|p| p.path.as_path())
            .ok_or_else(|| anyhow::anyhow!("prediction 任务缺少预测文件（artifact_download_url）"))?;
        let file_name = task.file_name.clone().unwrap_or_else(|| "prediction.csv".to_string());
        return crate::prediction::evaluate_prediction(
            docker,
            &task.submission_id,
            &task.runtime_config,
            support_pkg.as_ref().map(|p| p.path.as_path()),
            prediction_path,
            &file_name,
            task.rejudge_seq,
            cpu_limit_millicores,
            allow_evaluator_network,
            evaluator_network_mode,
            image_prefix,
            command_whitelist,
            max_evaluator_time_ms,
            prediction_workspace_mb,
        )
        .await;
    }
```

`evaluate_with_cpu_limit` 形参尾部新增 `prediction_workspace_mb: u64`；`main.rs` 调用处传 `config.prediction_workspace_mb`。

- [ ] **Step 4: 模块声明**

`lib.rs` 与 `main.rs` 各加一次：`pub mod prediction;` / `mod prediction;`。

- [ ] **Step 5: 编译、clippy、单测**

Run: `cd noj-judge && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo nextest run --all-targets`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add noj-judge/src/judge/runner.rs noj-judge/src/lib.rs noj-judge/src/main.rs
git commit -S -m "feat(judge): 按 submission_mode 分派 prediction 路径"
```

---

### Task 10: judge prediction Docker E2E

**Files:**
- Create: `noj-judge/tests/e2e_prediction.rs`

**Interfaces:**
- Consumes: `prediction::evaluate_prediction`；`tests/common/mod.rs` 的 `is_e2e_enabled`/`get_docker`/`ensure_sdk_images`。

- [ ] **Step 1: 写测试**

```rust
//! prediction 单容器路径 E2E：合成支持包 + 预测文件 → 隐藏标签算分。
mod common;
// 用 #[ignore] + NOJ_RUN_E2E=1 + #[serial_test::serial] + 30s 外层超时，
// 参照 tests/e2e_dual_container.rs::dual_artifact_zip_injection 结构。

#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn prediction_end_to_end_scores_and_creates_no_solution_container() {
    if !common::is_e2e_enabled() { return; }
    let docker = common::get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    // 支持包 zip：evaluate.py（读 $NOJ_PREDICTION_DIR 唯一文件与 hidden.jsonl 算 accuracy，
    // 输出 ---RESULT--- + {"score":..,"details":{"cases":[{"case_id":"c1","status":"Accepted","hidden":true}]}}）
    // 预测文件：predictions.csv
    // 调 prediction::evaluate_prediction(...)，断言 status=="finished"、score>0、cases[0].hidden==true。
    // 断言不创建 Solution 容器：
    //   let containers = docker.list_containers(Some(ListContainersOptions{
    //       all: true, filters: HashMap::from([("label", vec!["com.noj.judge.dual.solution=true"])]), ..Default::default()
    //   })).await.unwrap();
    //   assert!(containers.is_empty());
}
```

- [ ] **Step 2: 运行 E2E**

Run: `cd noj-judge && NOJ_RUN_E2E=1 cargo test --test e2e_prediction -- --ignored --nocapture`
Expected: PASS；且断言 Solution 容器列表为空。

- [ ] **Step 3: 提交**

```bash
git add noj-judge/tests/e2e_prediction.rs
git commit -S -m "test(judge): prediction 单容器路径 E2E"
```

---

### Task 11: SDK `load_predictions`（安全加载）

**Files:**
- Create: `noj-judge/sdk/evaluator/noj_evaluator_sdk/prediction.py`
- Test: `noj-judge/sdk/evaluator/noj_evaluator_sdk/tests/test_prediction.py`

**Interfaces:**
- Produces: `load_predictions(path: str | None = None) -> PredictionBundle`；`PredictionBundle.rows: list[dict]`、`.columns: list[str]`、`.ids: list[str]`、`.path: str`。
- **不依赖 numpy 即可 import**（evaluator 镜像为基础 python:3.12-slim）。

- [ ] **Step 1: 写失败测试**

```python
class TestLoadPredictions(unittest.TestCase):
    def test_load_jsonl(self): ...
    def test_load_csv(self): ...
    def test_reject_pickle_extension(self): ...
    def test_single_file_dir_autodetect(self): ...   # NOJ_PREDICTION_DIR 下唯一文件
    def test_missing_dir_errors(self): ...
```

- [ ] **Step 2: 运行确认失败**

Run: `cd noj-judge/sdk/evaluator/noj_evaluator_sdk/tests && python3 test_prediction.py`
Expected: `ModuleNotFoundError: noj_evaluator_sdk.prediction`

- [ ] **Step 3: 实现**

```python
"""prediction 模式辅助：安全加载预测文件并做最小对齐校验。

安全约束：
- **禁止 pickle**：不调用任何反序列化器；``.npz`` 一律 ``allow_pickle=False``。
- 仅在 ``$NOJ_PREDICTION_DIR`` 下唯一存在一个文件时自动定位。
- 本模块的 import **不得依赖 numpy**（evaluator 基础镜像无 numpy）。
"""

from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass
from typing import Any, Optional

_REJECTED_EXT = {".pkl", ".pickle", ".pt", ".pth", ".bin", ".joblib", ".ckpt"}
_TEXT_EXT = {".csv", ".tsv", ".jsonl", ".json", ".txt"}
_NUMPY_EXT = {".npy", ".npz"}


@dataclass
class PredictionBundle:
    path: str
    columns: list[str]
    rows: list[dict[str, Any]]

    @property
    def ids(self) -> list[str]:
        """返回 ``id`` 列（缺失时按行号）。"""
        if self.rows and "id" in self.rows[0]:
            return [str(r["id"]) for r in self.rows]
        return [str(i) for i in range(len(self.rows))]


def _locate(path: Optional[str]) -> str:
    if path:
        return path
    d = os.environ.get("NOJ_PREDICTION_DIR", "/workspace/prediction")
    if not os.path.isdir(d):
        raise FileNotFoundError(f"预测目录不存在: {d}")
    files = [f for f in os.listdir(d) if os.path.isfile(os.path.join(d, f))]
    if len(files) != 1:
        raise ValueError(f"预测目录应恰好包含 1 个文件，实际 {len(files)} 个: {files}")
    return os.path.join(d, files[0])


def _check_extension(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in _REJECTED_EXT:
        raise ValueError(f"禁止 pickle 类格式: {ext}")
    return ext


def load_predictions(path: Optional[str] = None) -> PredictionBundle:
    p = _locate(path)
    ext = _check_extension(p)

    if ext in _TEXT_EXT:
        with open(p, "rb") as fh:
            if b"\x00" in fh.read(4096):
                raise ValueError("预测文件含 NUL 字节，疑似二进制/pickle")
        if ext == ".jsonl":
            rows = [json.loads(line) for line in open(p, encoding="utf-8") if line.strip()]
        elif ext == ".json":
            data = json.load(open(p, encoding="utf-8"))
            rows = data if isinstance(data, list) else [data]
        else:
            delim = "\t" if ext == ".tsv" else ","
            with open(p, encoding="utf-8", newline="") as fh:
                rows = [dict(r) for r in csv.DictReader(fh, delimiter=delim)]
        cols = list(rows[0].keys()) if rows else []
        return PredictionBundle(path=p, columns=cols, rows=rows)

    if ext in _NUMPY_EXT:
        try:
            import numpy as np  # noqa: PLC0415  —— 仅 numpy 格式需要；基础镜像可能缺失
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError("该预测格式需要 numpy，但评测镜像未安装") from exc
        if ext == ".npz":
            with np.load(p, allow_pickle=False) as npz:  # 硬编码 allow_pickle=False
                rows = []
                keys = list(npz.keys())
                arrays = [npz[k] for k in keys]
                n = len(arrays[0]) if arrays else 0
                for i in range(n):
                    rows.append({k: a[i].item() if a[i].ndim == 0 else a[i].tolist()
                                 for k, a in zip(keys, arrays)})
                return PredictionBundle(path=p, columns=keys, rows=rows)
        arr = np.load(p, allow_pickle=False)
        rows = [{"value": arr[i].item() if arr[i].ndim == 0 else arr[i].tolist()}
                for i in range(len(arr))]
        return PredictionBundle(path=p, columns=["value"], rows=rows)

    raise ValueError(f"不支持的预测格式: {ext or '(无扩展名)'}")


def assert_id_alignment(prediction: PredictionBundle, expected_ids: list[str]) -> None:
    """校验预测 ID 与隐藏标签 ID 完全一致（缺失/多余均报错）。"""
    got = set(prediction.ids)
    want = set(map(str, expected_ids))
    missing = want - got
    extra = got - want
    if missing or extra:
        raise ValueError(
            f"预测 ID 与期望不一致：缺少 {len(missing)} 个、多出 {len(extra)} 个"
        )
```

- [ ] **Step 4: 运行测试**

Run: `cd noj-judge/sdk/evaluator/noj_evaluator_sdk/tests && python3 test_prediction.py`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add noj-judge/sdk/evaluator/noj_evaluator_sdk/prediction.py noj-judge/sdk/evaluator/noj_evaluator_sdk/tests/test_prediction.py
git commit -S -m "feat(judge): Evaluator SDK 新增安全预测加载"
```

---

### Task 12: SDK 度量 + 结果集成 + 导出

**Files:**
- Modify: `noj-judge/sdk/evaluator/noj_evaluator_sdk/prediction.py`
- Modify: `noj-judge/sdk/evaluator/noj_evaluator_sdk/__init__.py`
- Test: `noj-judge/sdk/evaluator/noj_evaluator_sdk/tests/test_prediction.py`

**Interfaces:**
- Produces: `accuracy(pred, gold)`、`f1_score(...)`、`rmse(...)`、`mae(...)`、`roc_auc(...)`（纯 Python 实现，确定性）；`emit_case_scores(bundle, pairs, *, metric, score_scale=100.0)` 直接调用 `result.accept(...)` 并保证每 case 带 `hidden: true`。

- [ ] **Step 1: 写失败测试**

```python
def test_accuracy_basic(self): self.assertAlmostEqual(accuracy([1,0,1],[1,1,1]), 2/3)
def test_rmse_basic(self): self.assertAlmostEqual(rmse([1.0,2.0],[1.0,4.0]), (2.0)**0.5)
def test_roc_auc_perfect(self): self.assertEqual(roc_auc([0,0,1,1],[0.1,0.2,0.8,0.9]), 1.0)
def test_emit_cases_hidden_flag(self):  # 捕获 stdout 断言 details.cases 每项 hidden==True
```

- [ ] **Step 2: 运行确认失败**

Run: `cd noj-judge/sdk/evaluator/noj_evaluator_sdk/tests && python3 test_prediction.py`
Expected: FAIL

- [ ] **Step 3: 实现度量（纯 stdlib，不依赖 numpy）**

```python
def accuracy(pred: list[Any], gold: list[Any]) -> float:
    if not gold:
        return 0.0
    return sum(1 for p, g in zip(pred, gold) if p == g) / len(gold)


def rmse(pred: list[float], gold: list[float]) -> float:
    if not gold:
        return 0.0
    return (sum((float(p) - float(g)) ** 2 for p, g in zip(pred, gold)) / len(gold)) ** 0.5


def mae(pred: list[float], gold: list[float]) -> float:
    if not gold:
        return 0.0
    return sum(abs(float(p) - float(g)) for p, g in zip(pred, gold)) / len(gold)


def f1_score(pred: list[Any], gold: list[Any], positive: Any = 1) -> float:
    tp = sum(1 for p, g in zip(pred, gold) if p == positive and g == positive)
    fp = sum(1 for p, g in zip(pred, gold) if p == positive and g != positive)
    fn = sum(1 for p, g in zip(pred, gold) if p != positive and g == positive)
    if tp == 0:
        return 0.0
    precision = tp / (tp + fp)
    recall = tp / (tp + fn)
    return 2 * precision * recall / (precision + recall)


def roc_auc(labels: list[int], scores: list[float]) -> float:
    pos = [s for l, s in zip(labels, scores) if l == 1]
    neg = [s for l, s in zip(labels, scores) if l != 1]
    if not pos or not neg:
        return 0.0
    wins = sum(1.0 if p > n else 0.5 if p == n else 0.0 for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


def emit_case_scores(
    predictions: PredictionBundle,
    gold: dict[str, Any],
    *,
    metric: str = "accuracy",
    score_scale: float = 100.0,
) -> None:
    """按 case 计算并写出标准结果；每 case 必带 ``hidden: true``，不写隐藏标签内容。"""
    from . import result  # 延迟导入，避免循环依赖

    cases = []
    correct = 0
    total = 0
    for pid, pred_val in zip(predictions.ids, (r.get("value") for r in predictions.rows)):
        g = gold.get(str(pid))
        if g is None:
            continue
        total += 1
        ok = pred_val == g
        correct += 1 if ok else 0
        cases.append({
            "case_id": str(pid),
            "status": "Accepted" if ok else "WrongAnswer",
            "hidden": True,  # 唯一判据：不得省略
        })
    frac = (correct / total) if total else 0.0
    result.accept(score=frac * score_scale, details={"cases": cases})
```

> `metric` 参数在本任务仅支持 `accuracy`；其它度量作为可复用函数导出，由出题人自行组合。避免 YAGNI 地扩张。

- [ ] **Step 4: 导出**

`__init__.py` 追加：

```python
from .prediction import (
    PredictionBundle,
    accuracy,
    f1_score,
    mae,
    rmse,
    roc_auc,
    load_predictions,
    assert_id_alignment,
    emit_case_scores,
)
# __all__ 追加以上名称
```

- [ ] **Step 5: 运行测试**

Run: `cd noj-judge/sdk/evaluator/noj_evaluator_sdk/tests && python3 test_prediction.py && python3 test_result.py`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add noj-judge/sdk/evaluator/noj_evaluator_sdk
git commit -S -m "feat(judge): Evaluator SDK 新增确定性度量与结果集成"
```

---

### Task 13: core prediction 提交服务

**Files:**
- Create: `noj-core/src/domains/submission/services/submissions/prediction-format.ts`
- Create: `noj-core/src/domains/submission/services/submissions/prediction-submissions.ts`
- Modify: `noj-core/src/domains/submission/services/submissions/submissions.ts`（barrel）
- Test: `noj-core/src/domains/submission/tests/services/prediction-format.test.ts`

**Interfaces:**
- Produces: `validatePredictionFile(fileName: string, firstBytes: Uint8Array): void`（抛 `BadRequestError`，错误码 `PREDICTION_FORMAT_REJECTED`）；`createPredictionSubmission(userId, input, contestId?, clientIp?, isAdmin?) => Promise<SubmissionResponse>`。

- [ ] **Step 1: 写失败测试（纯函数）**

```ts
Deno.test("prediction-format: 接受 csv/jsonl/npy 魔数", () => {
  validatePredictionFile("pred.csv", new TextEncoder().encode("id,value\n1,0.5\n"));
  validatePredictionFile("pred.jsonl", new TextEncoder().encode("{\"id\":1}\n"));
});
Deno.test("prediction-format: 拒绝 pickle 扩展名", () => {
  assertThrows(() => validatePredictionFile("m.pkl", new Uint8Array([0x80, 0x04])), BadRequestError);
});
Deno.test("prediction-format: 拒绝 pickle 魔数", () => {
  assertThrows(() => validatePredictionFile("m.csv", new Uint8Array([0x80, 0x04, 1, 2])), BadRequestError);
});
Deno.test("prediction-format: 拒绝含 NUL 的文本", () => {
  assertThrows(() => validatePredictionFile("m.csv", new Uint8Array([0x61, 0x00, 0x62])), BadRequestError);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd noj-core && deno task test:domain submission`
Expected: FAIL

- [ ] **Step 3: 实现格式校验**

```ts
const REJECTED_EXT = [".pkl", ".pickle", ".pt", ".pth", ".bin", ".joblib", ".ckpt"];
const TEXT_EXT = [".csv", ".tsv", ".jsonl", ".json", ".txt"];
const NUMPY_EXT = [".npy", ".npz"];
const PARQUET_EXT = [".parquet"];

export function validatePredictionFile(fileName: string, firstBytes: Uint8Array): void {
  const lower = fileName.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf("."));
  if (REJECTED_EXT.includes(ext)) {
    throw new BadRequestError("禁止 pickple 类格式（存在反序列化风险）", "PREDICTION_FORMAT_REJECTED");
  }
  if (![...TEXT_EXT, ...NUMPY_EXT, ...PARQUET_EXT].includes(ext)) {
    throw new BadRequestError(`不支持的预测文件格式：${ext}`, "PREDICTION_FORMAT_REJECTED");
  }
  const b = firstBytes;
  // pickle 协议头
  if (b.length >= 2 && b[0] === 0x80 && (b[1] === 0x04 || b[1] === 0x05)) {
    throw new BadRequestError("检测到 pickle 协议头，已拒绝", "PREDICTION_FORMAT_REJECTED");
  }
  if (ext === ".npz" && !(b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b)) {
    throw new BadRequestError("npz 文件头不合法", "PREDICTION_FORMAT_REJECTED");
  }
  if (ext === ".npy" && !(b.length >= 6 && b[0] === 0x93 && b.slice(1, 6).every((v, i) => v === "NUMPY".charCodeAt(i)))) {
    throw new BadRequestError("npy 文件头不合法", "PREDICTION_FORMAT_REJECTED");
  }
  if (ext === ".parquet" && !(b.length >= 4 && b[0] === 0x50 && b[1] === 0x41 && b[2] === 0x52 && b[3] === 0x31)) {
    throw new BadRequestError("parquet 文件头不合法", "PREDICTION_FORMAT_REJECTED");
  }
  if (TEXT_EXT.includes(ext) && b.includes(0x00)) {
    throw new BadRequestError("预测文件含 NUL 字节，疑似二进制", "PREDICTION_FORMAT_REJECTED");
  }
}
```

- [ ] **Step 4: 实现服务（对齐 `artifact-submissions.ts`）**

`prediction-submissions.ts` 结构：竞赛限次 → 行级锁读题目 → 访问解析 → `problem.submission_mode === "prediction"` 校验 → `peekFirstChunk` 取头部 → `validatePredictionFile` → 双层大小上限（复用 `getArtifactHardLimit` + `problem.artifact_max_size_mb`）→ `storage.putStream("artifacts/<uuid><ext>", rest, "application/octet-stream", maxSizeBytes)` → 支持包 download_url → 校验 `runtime_config.evaluator` 镜像 kind → `buildJudgeTask({ ..., submission_mode: "prediction", artifact_download_url: <预测文件 URL>, file_name })` → 插入 `submissions`（`artifact_storage_url` = 预测文件 URL、`code: ""`）→ 入队 → SSE。失败清理逻辑与 artifact 同构。

> 复用 `peekFirstChunk`：将其从 `artifact-submissions.ts` 导出或抽到共享模块，避免复制。

- [ ] **Step 5: barrel 导出**

`submissions.ts` 加 `export { createPredictionSubmission } from "./prediction-submissions.ts";`

- [ ] **Step 6: 运行测试**

Run: `cd noj-core && deno task test:domain submission`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add noj-core/src/domains/submission/services/submissions
git commit -S -m "feat(core): prediction 提交服务与格式校验"
```

---

### Task 14: core 路由按模式分派

**Files:**
- Modify: `noj-core/src/domains/submission/routes/submissions.ts:194`
- Modify: `noj-core/src/domains/contest/routes/contests.ts:356`
- Test: `noj-core/src/domains/submission/tests/routes/submissions.test.ts`

**Interfaces:**
- Consumes: `createPredictionSubmission`（Task 13）

- [ ] **Step 1: 写失败测试**

```ts
Deno.test("routes: prediction 题 multipart 提交走 prediction 服务", async () => {
  // 建 prediction 题 → multipart 上传 .csv → 201，submission 落库 artifact_storage_url 非空
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd noj-core && deno task test:domain submission`
Expected: FAIL（会走 artifact 服务并因扩展名非 .zip 报错）

- [ ] **Step 3: 路由分派**

普通提交路由（`submissions.ts` multipart 分支）：先按 `problem_id` 解析题目模式，再分派：

```ts
  if (contentType.startsWith("multipart/form-data")) {
    const parsed = await parseArtifactMultipart(c);
    const problem = await getProblemForSubmission(parsed.problem_id); // 复用既有解析
    const result = problem.submission_mode === "prediction"
      ? await createPredictionSubmission(userId, parsed, undefined, clientIp, isAdmin)
      : await createArtifactSubmission(userId, parsed, undefined, clientIp, isAdmin);
    return c.json({ data: result }, 201);
  }
```

竞赛路由同理（`contests.ts:356` 分支内，已解析题目成员校验后分派）。

> 若既有代码无 `getProblemForSubmission`，则在服务层内部判定：给 `createArtifactSubmission` / `createPredictionSubmission` 增加模式守卫并让路由先调用一个轻量 `resolveSubmissionMode(problem_id)`；避免重复查询，优先在路由层一次性解析。

- [ ] **Step 4: 运行测试**

Run: `cd noj-core && deno task test:domain submission && cd ../noj-core && deno task test:domain contest`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add noj-core/src/domains/submission/routes/submissions.ts noj-core/src/domains/contest/routes/contests.ts
git commit -S -m "feat(core): 提交路由按 submission_mode 分派 prediction"
```

---

### Task 15: core prediction 端到端行为测试

**Files:**
- Test: `noj-core/src/domains/submission/tests/services/prediction-submissions.test.ts`

- [ ] **Step 1: 写测试**

覆盖：prediction 题 + `.csv` 成功落库（`artifact_storage_url` 非空、`submission_mode` 传入任务）；`.pkl` 拒绝；大小超限拒绝；非 prediction 题走 prediction 服务被拒；入队失败清理对象；prediction 提交不可重测（`artifact_storage_url` 非空触发现有拒绝）。

- [ ] **Step 2: 运行**

Run: `cd noj-core && deno task test:domain submission`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add noj-core/src/domains/submission/tests/services/prediction-submissions.test.ts
git commit -S -m "test(core): prediction 提交服务行为测试"
```

---

### Task 16: noj-ui 接入

**Files:**
- Modify: `noj-ui/components/editor/CodingProblemEditor.vue`
- Modify: `noj-ui/utils/problemView.ts`
- Modify: `noj-ui/pages/editor/[id].vue`、`noj-ui/pages/problems/[id].vue`、`noj-ui/pages/contests/[contestId]/problems/[label].vue`
- Test: `noj-ui/tests/problemView_test.ts`

- [ ] **Step 1: 写失败测试**

`problemView_test.ts` 加 prediction 模式判定与文案断言。

- [ ] **Step 2: 运行确认失败**

Run: `cd noj-ui && deno task test`
Expected: FAIL

- [ ] **Step 3: 实现**

- `CodingProblemEditor.vue`：模式下拉增加「预测提交题」；prediction 下隐藏 Solution 运行时配置区、保留 `artifact_max_size_mb` 输入；对 prediction 的 `runtime_config` 提交体省略 `solution`。
- `problemView.ts`：新增 `isPrediction` 判定与「本地 GPU 出分」说明文案。
- 各提交页：prediction 显示**单文件**上传（复用 artifact 上传组件，`accept` 白名单为预测扩展名），提示「本地自评 / 题面外链数据集」。

- [ ] **Step 4: 运行 UI 检查**

Run: `cd noj-ui && deno fmt && deno lint && deno task check:types:nuxt && deno task test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add noj-ui
git commit -S -m "feat(ui): 支持预测提交题的出题与作答"
```

---

### Task 17: 文档

**Files:**
- Create: `noj-docs/docs/problemsetters/prediction-problems.md`
- Modify: `noj-docs/docs/users/submit.md`、`noj-docs/docs/standards/test-data.md`、`noj-docs/docs/mechanisms/runtimes.md`、`noj-docs/docs/.vitepress/config.ts`

- [ ] **Step 1: 写文档**

- `prediction-problems.md`：公开数据由出题人外链、预测文件格式与 ID 对齐、`evaluate.py` 用 `load_predictions` 读 `$NOJ_PREDICTION_DIR`、**禁止 pickle**、每 case 必带 `hidden: true`、不得回写隐藏标签。
- `submit.md`：新增「预测提交」小节（单文件、格式白名单、不支持重测）。
- `test-data.md`：补「公开数据 / 隐藏标签分离」约定。
- `runtimes.md`：补 prediction 单容器运行时。
- `config.ts`：侧边栏加入 `prediction-problems`。

- [ ] **Step 2: 构建链接检查**

Run: `cd noj-docs && deno task build`（或仓库既有文档构建命令）
Expected: 无坏链

- [ ] **Step 3: 提交**

```bash
git add noj-docs
git commit -S -m "docs(root): 预测提交题出题与作答文档"
```

---

### Task 18: Agent Note + env 文档 + 模块文档

**Files:**
- Create: `.agents/notes/implemented/feature/2026-09-21-local-gpu-prediction-submission.md`
- Modify: `.env.prod.example`、`noj-judge/AGENTS.md`
- Modify: `noj-core/.env.example` + `noj-core/src/shared/config/settings-registry.ts`（若 prediction 相关 env 需在 core 登记）

- [ ] **Step 1: Agent Note**

格式：`# Agent Note: <标题>` + `Status: implemented` + `## Problem` / `## Decision` / `## Alternatives considered` / `## Consequences`。记录「本地 GPU 出分的信任边界」「判据不出服务端」不可动摇约束。

- [ ] **Step 2: env 文档**

`.env.prod.example` 的 Judge Worker 段追加 `JUDGE_PREDICTION_WORKSPACE_MB=2048`；`noj-judge/AGENTS.md` 环境变量表与技术流程同步。

- [ ] **Step 3: 门禁**

Run: `deno run -A scripts/verify-agent-note-format.ts && cd noj-core && deno task check:env`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add .agents .env.prod.example noj-judge/AGENTS.md noj-core/.env.example noj-core/src/shared/config/settings-registry.ts
git commit -S -m "docs(root): prediction 决策记录与环境变量文档"
```

---

### Task 19: noj-tests 跨模块 E2E

**Files:**
- Create: `noj-tests/e2e/submission/prediction_submission.test.ts`

- [ ] **Step 1: 写 E2E**

参照 `artifact_submission.test.ts`：admin 建 prediction 题（evaluator 命令读取 `$NOJ_PREDICTION_DIR` 唯一文件与内联 hidden 标签，`result` 输出 `hidden: true` case）→ 用户 multipart 上传 `.csv` → 轮询 `/api/v1/submissions/:id` → 断言 `finished` 且 `score > 0`。

- [ ] **Step 2: 运行（需完整评测栈）**

Run: `cd noj-tests && deno task test:domain submission`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add noj-tests/e2e/submission/prediction_submission.test.ts
git commit -S -m "test(root): prediction 跨模块 E2E"
```

---

### Task 20: 全量门禁 + draft PR

- [ ] **Step 1: 本地全量门禁**

```bash
cd noj-core && deno fmt && deno lint && find src -name '*.ts' -print0 | xargs -0 deno check && deno task check:jsdoc && deno task check:config-usage
cd ../noj-judge && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo nextest run --all-targets
cd ../noj-ui && deno fmt && deno lint && deno task check:types:nuxt && deno task build && deno task test
cd .. && deno run -A scripts/check-ci.ts
```

- [ ] **Step 2: 逐域测试**

```bash
cd noj-core && deno task test:domain submission && deno task test:domain catalog && deno task test:domain contest
```

- [ ] **Step 3: 推送分支并开 draft PR**

```bash
git push -u origin feat/local-gpu-prediction-submission
gh pr create --draft --base main --title "feat: 预测提交题（本地 GPU 出分，服务端判分）" \
  --body "$(cat <<'EOF'
## 背景
支持选手用本地 GPU 产出预测文件、由服务端在隐藏标签上确定性算分，结果进入正式计分。

## 设计
见 dev-docs/superpowers/specs/2026-09-21-local-gpu-prediction-submission-design.md

## 关键约束
- 隐藏判据只进 Evaluator；prediction 路径不创建 Solution 容器、不执行不可信代码
- 禁止 pickle；预测文件复用 artifact 存储列与生命周期；不支持重测
EOF
)"
```

- [ ] **Step 4: 观察 CI 直至全绿**

Run: `gh pr checks --watch`
Expected: 全部通过（core-* / judge-check / ui-check / Root Gates / E2E / Production CLI 等）。

- [ ] **Step 5: 记录验收证据**

将 `gh pr checks` 通过输出与 subagent 评审 READY 结论写入 PR 评论或会话总结。

---

## Self-Review

**Spec coverage：**
- §3.1 契约 → Task 1/2 ✅
- §3.2 core 服务与路由 → Task 13/14/15 ✅
- §3.3 judge 单容器路径 → Task 5/6/7/8/9/10 ✅
- §3.4 Evaluator SDK → Task 11/12 ✅
- §3.5 UI → Task 16 ✅
- §3.6 文档 → Task 17 ✅
- §3.7 Agent Note → Task 18 ✅
- §4 公平与安全（禁 pickle、隐藏标记、ID 对齐）→ Task 11/12/13 ✅
- §5 执行顺序 → Task 1→20 顺序一致 ✅
- §6 验证（契约/核心/judge/SDK/E2E/迁移/文档）→ 各任务 Step + Task 20 ✅
- §9 Phase 2 项（大数据集、公开/私有榜、重测、bind mount、服务端复算）→ 显式不做 ✅

**Placeholder scan：** 无 TBD/TODO；每个代码步骤含实际代码或精确落点。

**Type consistency：** `submission_mode`（TS/Rust/fixture/契约测试）四处同名；`workspace_size_mb` 与 `prediction_workspace_mb` 的题目级/judge 级命名区分一致；`evaluate_prediction` / `createPredictionSubmission` / `load_predictions` 在消费方与产出方命名一致。

**已知执行风险（执行者须注意）：**
1. Task 7 的 `tar::Builder` 与 `AsyncWrite` 组合可能不满足 `std::io::Write`；需以实际编译为准改为管道 + `tokio::io::copy`，但**不得违反「不整文件读入内存」**。
2. Task 14 需先确认路由层是否已有题目解析辅助；若无，避免重复查询，优先一次性解析。
3. Task 2 与 Task 1 必须同提交，否则 `deno check` 失败。
4. evaluator 基础镜像**无 numpy**：Task 11 的非 numpy 路径必须可在无 numpy 环境运行，仅 `.npy/.npz` 分支延迟 import。
