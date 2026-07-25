# OpenSpec 三变更归档收尾 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `openspec/changes/` 下三个已落地但未归档的变更（`add-noj-docs`、`dual-container-judge`、`remove-single-container-mode`）正式归档，并把 spec 增量同步到 `openspec/specs/` 主规范。

**Architecture:** 文档与 OpenSpec 元数据清理。补齐 `remove-single-container-mode` 缺失的 proposal/tasks；按 agent-driven intelligent merging 同步 3 份 spec 增量到主 specs（含 `judge-worker` 单容器 scenarios 的精细拆分、镜像白名单 kind 字段升级、新建 `problem-runtime-config` 主 spec、归档 `container-pool` 主 spec）；勾选 tasks.md；按 `YYYY-MM-DD-<name>/` 命名归档三个变更；单 commit 提交。

**Tech Stack:** Markdown / 文件系统操作 / git mv / grep 验证 / Conventional Commits (中文) / GPG 签名。

**Spec 引用：** `docs/superpowers/specs/2026-07-25-openspec-archive-cleanup-design.md`

## Global Constraints

- 本计划**不动任何运行时模块**：noj-core / noj-ui / noj-judge / 数据库 migrations / GitHub Actions / docker-compose 全部零改动。
- 仅允许修改/创建 `openspec/`、`docs/superpowers/plans/`（本文件）三个区域。
- 提交规范：中文 Conventional Commits，GPG 签名（key `F27B5D0A639B43695413D9440F49774CB31F6CF1`）。
- 所有归档目录统一前缀 `2026-07-25-`；冲突时改用 `-v2` 后缀。
- archive 时使用 `git mv`（不是 `mv`）以保留 git 历史。
- `openspec` CLI 在本机不可用——所有验证用 grep / ls / Read 完成。

---

## Task 1: 补 `remove-single-container-mode/proposal.md`

**Files:**
- Create: `openspec/changes/remove-single-container-mode/proposal.md`

**Interfaces:**
- Produces: 一份与 `add-noj-docs/proposal.md`、`dual-container-judge/proposal.md` 同构的回溯式 proposal。
- 引用源: `openspec/changes/remove-single-container-mode/design.md`（已存在，作为 Why/Migration Plan 的事实来源）。

- [ ] **Step 1: 写 proposal.md 完整内容**

在 `openspec/changes/remove-single-container-mode/proposal.md` 写入以下内容（中文，与现有 proposal 模板同构）：

```markdown
# 移除单容器评测模式

## Why

NOJ 评测 Worker 在 PR #146 引入双容器编排（Evaluator + Solution，NDJSON 协议）
后，仍保留单容器模式作为 `JudgeMode::Single` 分支：

- 维护两条评测路径增加代码复杂度与测试负担；
- 单容器模式下用户代码与 `evaluate.py` 共享文件系统/进程，存在安全隔离缺陷；
- rejudge 路径存在 bug：忽略 `runtime_config`，总是走单容器模式；
- 单容器模式的 `pool/` 模块（PoolManager 容器池）在双容器路径下不再使用，已是 dead code；
- `JudgeTask` 上的 `mode` / `judge_image` / `judge_command` 字段、`problems` 表上的
  `judge_image` / `judge_command` 列已成为条件分支根源，简化消息格式可降低出错面；
- 项目尚未投产，无存量数据迁移负担，样例题（1001/1002/1003）可直接同步切换。

本变更统一所有评测走双容器编排路径，作为 Phase 1 收尾的组成部分。

## What Changes

- 移除 `JudgeMode` 枚举（`Single` / `Dual` 二选一），所有评测统一走
  `dual::evaluate_dual()` 路径。
- `runtime_config` 成为 `problems` 表必填字段（NOT NULL），通过迁移将现有 NULL 题目批量填入合理默认值。
- 从 `noj-judge` 删除整个单容器代码路径：`pool/` 模块（PoolManager、
  `evaluate_with_pool`、`docker cp` 文件注入）、`JudgeMode::Single` 分支。
- 从 `JudgeTask`（Rust 侧与 TS 侧）移除 `mode` / `judge_image` / `judge_command` 字段；
  `runtime_config` 从 `Option` 变为必填。
- 从 `problems` 表删除 `judge_image` / `judge_command` 列（Drizzle 迁移）。
- 修复 rejudge 路径缺少 `runtime_config` 的 regression
  （`rejudgeSubmission` / `rejudgeProblemSubmissions`）。
- 前端 `ProblemEditor.vue` 移除 `dualMode` 开关与 `judge_image` / `judge_command` 选择器；
  始终渲染 RuntimeConfig 表单。
- 样例题 1001 / 1002 / 1003 的 `evaluate.py` 全部改为双容器 NDJSON 协议实现；
  seed 脚本使用 `runtime_config` 替代 `judge_image` / `judge_command`。
- 清理不再需要的环境变量：`POOL_INITIAL_SIZE` / `POOL_MAX_SIZE` /
  `POOL_MIN_SIZE` / `POOL_IDLE_TIMEOUT` / `POOL_LABEL_PREFIX` /
  `POOL_MAX_ARCHIVE_MB` / 健康检查后台任务；保留与容器执行相关的
  `POOL_MEMORY_MB` / `POOL_CPU` / `POOL_KILL_GRACE_SECONDS`（双容器路径仍使用）。

## Capabilities

### Modified Capabilities

- `judge-worker`：移除单容器 exec 流程相关 scenarios；移除"runtime_config IS NULL 走单容器"分支；新增 "runtime_config 必填校验" scenario。
- `container-pool`：整体撤销（主 spec 移至 `archive/2026-07-25-container-pool-superseded/`）。

### Removed Capabilities

- 无（`container-pool` 主 spec 通过归档处理，规范层面不删除）。

## Impact

- `noj-judge/src/types.rs`：`JudgeTask` 精简（移除 `mode` / `judge_image` / `judge_command`）。
- `noj-judge/src/main.rs`：移除模式分流，始终调用 `dual::evaluate_dual()`。
- `noj-judge/src/judge/runner.rs`：移除 `evaluate_with_pool`，只保留 dual 相关逻辑 + `process_output()`。
- `noj-judge/src/pool/`：整个目录删除（PoolManager、懒回补、健康检查、文件注入等）。
- `noj-core/src/types/index.ts`：移除 `JudgeMode` 枚举；`RuntimeConfig` 相关类型保留。
- `noj-core/src/services/submissions.ts`：移除模式判断；始终使用 `runtime_config`；修复 rejudge 路径。
- `noj-core/src/services/problems.ts`：移除 `judge_image` / `judge_command` 字段；`runtime_config` 必填校验。
- `noj-core/src/routes/admin.ts`：题目 CRUD 路由移除 `judge_image` / `judge_command` 字段。
- `noj-core/src/db/schema.ts`：`problems` 表删除 `judge_image` / `judge_command` 列。
- Drizzle 迁移：新增 `0019_remove_judge_image_judge_command.sql` 删除列；新增 `0020_runtime_config_not_null.sql`（按需）。
- `noj-ui/components/editor/ProblemEditor.vue`：移除 `dualMode` 开关；移除 `judge_image` / `judge_command` 选择器；始终渲染 RuntimeConfig 表单。
- `noj-core/data/problems-src/1001/` / `1002/` / `1003/`：`evaluate.py` 改为双容器 NDJSON 协议。
- `noj-core/scripts/seed.ts`：使用 `runtime_config` 替代 `judge_image` / `judge_command`。
- 测试：noj-judge 单元测试移除 `JudgeMode::Single` 引用与 pool 相关测试；noj-core 服务测试更新；E2E 测试 `15_dual_container_judge.test.ts` 覆盖回归。

## Out of Scope

- 不改变双容器 NDJSON 协议本身。
- 不改变 Evaluator / Solution 镜像构建方式。
- 不改变支持包缓存机制（缓存逻辑由 dual 路径内部复用）。
- 不修复 `pool/mod.rs` 1050 行等技术债（属于后续 OpenSpec 变更范畴；本变更在移除后已无该文件）。
- 不引入非 Python Solution 镜像（v1 仍仅 Python）。
```

- [ ] **Step 2: 验证文件创建成功**

Run: `wc -l openspec/changes/remove-single-container-mode/proposal.md`
Expected: 输出一个 > 80 的行数。

- [ ] **Step 3: 验证不含占位符**

Run: `grep -nE 'TBD|TODO|XXX|FIXME|HACK|fill in|implement later' openspec/changes/remove-single-container-mode/proposal.md`
Expected: 无输出（exit code 1 = grep 未找到）。

- [ ] **Step 4: Commit**

```bash
git add openspec/changes/remove-single-container-mode/proposal.md
git commit -m "docs(openspec): 补 remove-single-container-mode 缺失的 proposal"
```

---

## Task 2: 补 `remove-single-container-mode/tasks.md`

**Files:**
- Create: `openspec/changes/remove-single-container-mode/tasks.md`

**Interfaces:**
- Produces: 一份 6 个 task group 的 tasks.md，所有任务勾上 [x]（实现已落地）。
- 与 Task 1 的 proposal.md 配对，构成完整"三件套"。

- [ ] **Step 1: 写 tasks.md 完整内容**

在 `openspec/changes/remove-single-container-mode/tasks.md` 写入：

```markdown
# 移除单容器评测模式 — 任务拆分

> 总体范围：移除单容器路径，统一走双容器编排。详细设计见 `design.md`、
> 提案背景见 `proposal.md`。

## 1. 样例题 + seed 更新

- [x] 1.1 更新 1001/1002/1003 的 `evaluate.py` 为双容器 NDJSON 协议
- [x] 1.2 更新 `noj-core/scripts/seed.ts`：使用 `runtime_config` 替代 `judge_image`/`judge_command`

## 2. 数据库 Schema 更新

- [x] 2.1 Drizzle 迁移 `0019_remove_judge_image_judge_command.sql`：
  - [x] `ALTER TABLE problems DROP COLUMN judge_image`
  - [x] `ALTER TABLE problems DROP COLUMN judge_command`
  - [x] 视需要追加 `0020_runtime_config_not_null.sql`：将 `runtime_config` 由 NULL 改为 NOT NULL（按 seed 数据回填）
- [x] 2.2 `noj-core/src/db/schema.ts`：移除 `problems.judge_image` / `judge_command` 字段定义

## 3. noj-core 代码更新

- [x] 3.1 `noj-core/src/types/index.ts`：移除 `JudgeMode` 枚举；`RuntimeConfig` 类型保留
- [x] 3.2 `noj-core/src/services/submissions.ts`：移除模式判断；始终使用 `runtime_config`
- [x] 3.3 `noj-core/src/services/problems.ts`：移除 `judge_image` / `judge_command` 字段；`runtime_config` 必填校验
- [x] 3.4 修复 rejudge 路径：`rejudgeSubmission` / `rejudgeProblemSubmissions` 不再丢失 `runtime_config`
- [x] 3.5 `noj-core/src/routes/admin.ts`：题目 CRUD 路由移除 `judge_image` / `judge_command` 字段

## 4. noj-judge 代码更新

- [x] 4.1 移除 `JudgeMode` 枚举
- [x] 4.2 删除整个 `noj-judge/src/pool/` 模块（PoolManager、懒回补、健康检查、文件注入）
- [x] 4.3 简化 `noj-judge/src/judge/runner.rs`：移除 `evaluate_with_pool`，只保留 dual 相关逻辑 + `process_output()`
- [x] 4.4 简化 `noj-judge/src/main.rs`：移除模式分流，始终调用 `dual::evaluate_dual()`
- [x] 4.5 清理环境变量：移除 `POOL_INITIAL_SIZE` / `POOL_MAX_SIZE` / `POOL_MIN_SIZE` / `POOL_IDLE_TIMEOUT` / `POOL_LABEL_PREFIX` / `POOL_MAX_ARCHIVE_MB`；保留 `POOL_MEMORY_MB` / `POOL_CPU` / `POOL_KILL_GRACE_SECONDS`（dual 路径仍使用）
- [x] 4.6 简化 `noj-judge/src/types.rs`：`JudgeTask` 移除 `mode` / `judge_image` / `judge_command` 字段；`runtime_config` 改必填

## 5. noj-ui 代码更新

- [x] 5.1 `noj-ui/components/editor/ProblemEditor.vue`：移除 `dualMode` ref 和开关 UI
- [x] 5.2 移除 `judge_image` / `judge_command` 选择器；改为在 RuntimeConfig 内选择 Evaluator 镜像与命令
- [x] 5.3 始终渲染 RuntimeConfig 配置区域

## 6. 测试更新

- [x] 6.1 更新 `noj-judge` 单元测试：移除 `JudgeMode::Single` 引用；移除 pool 相关测试
- [x] 6.2 更新 `noj-core` 服务测试：移除单容器分支断言
- [x] 6.3 更新 E2E 测试：`noj-tests/e2e/15_dual_container_judge.test.ts` 覆盖全双容器路径回归
- [x] 6.4 CI 全绿：`cargo fmt` + `cargo clippy` + `cargo test` + `deno fmt --check` + `deno lint` + `deno task test` + `npm run build` 全过
```

- [ ] **Step 2: 验证文件创建成功且任务全部勾上**

Run: `grep -c '^- \[x\]' openspec/changes/remove-single-container-mode/tasks.md && grep -c '^- \[ \]' openspec/changes/remove-single-container-mode/tasks.md`
Expected: 第一行输出 ≥ 20（勾选数），第二行输出 `0`（无未勾选）。

- [ ] **Step 3: Commit**

```bash
git add openspec/changes/remove-single-container-mode/tasks.md
git commit -m "docs(openspec): 补 remove-single-container-mode 缺失的 tasks"
```

---

## Task 3: 新建 `problem-runtime-config` 主 spec（改写冲突场景）

**Files:**
- Create: `openspec/specs/problem-runtime-config/spec.md`

**Interfaces:**
- Consumes: `openspec/changes/dual-container-judge/specs/problem-runtime-config/spec.md`（作为 ADDED Requirements 源）。
- Produces: 新主 spec 目录 `openspec/specs/problem-runtime-config/`。后续被 Task 8 archive 后由 `archive/2026-07-25-dual-container-judge/specs/problem-runtime-config/spec.md` 历史保留。

- [ ] **Step 1: 写主 spec 完整内容**

在 `openspec/specs/problem-runtime-config/spec.md` 写入：

```markdown
## Purpose

定义 Neuro OJ 题目运行时配置（runtime_config）规范。runtime_config 是题目
JSONB 列，描述双容器评测模式下 Evaluator 与 Solution 各自运行时参数，
替代单容器时代的 `judge_image` / `judge_command` 字段。

## Requirements

### Requirement: 题目运行时配置（runtime_config）

系统 SHALL 在 `problems` 表中存储 JSONB 格式的 `runtime_config`，用于描述双容器
评测模式下的 Evaluator 与 Solution 各自运行时参数，且 runtime_config 为必填。

#### Scenario: problems 表新增 runtime_config 列（NOT NULL）

- **WHEN** Drizzle 迁移 `0017_problem_runtime_config.sql` 与 `0020_runtime_config_not_null.sql` 全部执行
- **THEN** `problems` 表含 `runtime_config JSONB NOT NULL` 列
- **THEN** 附加 CHECK 约束：`jsonb_typeof(runtime_config) = 'object'`

#### Scenario: RuntimeConfig 结构

- **WHEN** admin 设置 `runtime_config` 字段
- **THEN** 必填结构：
  - `evaluator.image: string`（必填，Docker 镜像名）
  - `evaluator.command: string`（必填，如 `python3 /workspace/evaluate.py`）
  - `evaluator.time_limit_ms: number`（必填，> 0）
  - `evaluator.memory_limit_mb: number`（必填，> 0）
  - `solution.image: string`（必填）
  - `solution.entry: string`（必填，如 `solution.py`）
  - `solution.call_timeout_ms: number`（必填，> 0）
  - `solution.memory_limit_mb: number`（必填，> 0）

#### Scenario: runtime_config 缺字段校验失败

- **WHEN** admin 提交题目创建/更新请求，`runtime_config` 缺失任一必填字段
- **THEN** API 返回 HTTP 400，错误信息明确指出缺失字段

### Requirement: admin API 处理 runtime_config

系统 SHALL 允许 admin 通过题目 CRUD API 设置 / 更新 `runtime_config` 字段。

#### Scenario: admin 创建题目时设置 runtime_config

- **WHEN** admin 发送 `POST /api/v1/admin/problems`，payload 含合法 `runtime_config`
- **THEN** 系统校验：结构合法 + evaluator/solution image 在白名单中 + kind 匹配
- **THEN** 校验通过则创建题目，runtime_config 写入 JSONB 列
- **WHEN** 任何校验失败
- **THEN** 返回 HTTP 400 + 明确错误（image_not_allowlisted / kind_mismatch / invalid_structure）

#### Scenario: admin 更新题目时设置 runtime_config

- **WHEN** admin 发送 `PUT /api/v1/admin/problems/:id`，payload 含 `runtime_config`
- **THEN** 系统执行与创建相同的校验
- **THEN** 校验通过则更新 runtime_config 字段
- **THEN** 记录审计日志 `action=problems.runtime_config_changed`

#### Scenario: 普通用户创建题目不允许配置 runtime_config

- **WHEN** 普通用户（role='user'）发送 `POST /api/v1/problems`，payload 含 `runtime_config`
- **THEN** 系统返回 HTTP 403，提示仅 admin 可配置双容器评测

### Requirement: 提交流程按 runtime_config 调度

系统 SHALL 在 submissions service 推 MQ 前读取题目 `runtime_config`（必填），构造
dual 模式 JudgeTask。

#### Scenario: 题目 runtime_config 必填走双容器

- **WHEN** 题目 `runtime_config IS NOT NULL`（必然，因 NOT NULL 约束）
- **THEN** submissions service 构造 `JudgeTask { runtime_config, ... }`
- **THEN** 推 `noj:judge:queue`，judge 端按 dual 路径执行

#### Scenario: 题目行级锁避免并发修改

- **WHEN** submissions service 准备推 MQ
- **THEN** 先以 `SELECT ... FOR UPDATE`（或基于 `updated_at` 的乐观锁）锁住题目行
- **THEN** 在同一事务内读取 `runtime_config` 并构造 task
- **WHEN** admin 在此期间尝试更新题目
- **THEN** admin 更新阻塞直到 submissions service 提交
- **THEN** 避免 admin 修改 runtime_config 后提交仍走旧配置的竞态

#### Scenario: 推 MQ 前再校验白名单

- **WHEN** submissions service 构造完 task 准备推 MQ
- **THEN** 再次读取 `judge_images` 白名单确认 `runtime_config.evaluator.image` 与 `runtime_config.solution.image` 仍可用且 kind 匹配
- **WHEN** 镜像被下架或 kind 被改
- **THEN** 返回 `image_not_allowlisted` 错误，submission 标记为 error

### Requirement: 导出导入兼容

系统 SHALL 在题目导出/导入时支持 `runtime_config` 字段。

#### Scenario: 导出包含 runtime_config

- **WHEN** admin 导出题目
- **THEN** `ExportProblem` 结构包含 `runtime_config: RuntimeConfig`

#### Scenario: 导入新版本文件

- **WHEN** 导入文件 version = '1.0' 且含 `runtime_config`
- **THEN** 解析时校验结构 + 白名单 + kind
- **WHEN** 校验失败
- **THEN** 该题目标记为 failed，reason 包含失败原因
- **THEN** 不影响其他题目的导入

### Requirement: 审计日志

系统 SHALL 记录 admin 对题目 runtime_config 的修改。

#### Scenario: 设置或修改 runtime_config

- **WHEN** admin 创建或更新题目并修改 `runtime_config`
- **THEN** 审计日志出现 `action=problems.runtime_config_changed`
- **THEN** `detail` 包含 `problem_id`、`display_id`、旧值摘要（has_runtime_config: bool）、新值摘要（has_runtime_config: bool）

### Requirement: 公开题目 API 包含 runtime_config

系统 SHALL 在公开题目查询 API 中暴露 `runtime_config` 字段供前端使用。

#### Scenario: GET /problems/:id 返回 runtime_config

- **WHEN** 用户查询题目详情
- **THEN** 响应体包含 `runtime_config: RuntimeConfig`

#### Scenario: 列表 API 不暴露 runtime_config

- **WHEN** 用户查询题目列表
- **THEN** 列表项不包含 `runtime_config` 字段（避免列表响应过大）
- **THEN** 仅返回基础元数据（id / display_id / title / difficulty 等）
```

- [ ] **Step 2: 验证文件结构**

Run: `test -f openspec/specs/problem-runtime-config/spec.md && echo OK`
Expected: 输出 `OK`。

- [ ] **Step 3: 验证不出现冲突场景**

Run: `grep -nE '清空.*回退.*单容器|IS NULL.*走单容器|JudgeMode.*Single' openspec/specs/problem-runtime-config/spec.md`
Expected: 无输出。

- [ ] **Step 4: Commit**

```bash
git add openspec/specs/problem-runtime-config/spec.md
git commit -m "docs(openspec): 新建 problem-runtime-config 主规范"
```

---

## Task 4: 修改 `judge-image-whitelist` 主 spec（合并 kind 字段）

**Files:**
- Modify: `openspec/specs/judge-image-whitelist/spec.md`

**Interfaces:**
- Consumes: `openspec/changes/dual-container-judge/specs/judge-image-whitelist/spec.md`（MODIFIED Requirements 源）。
- Produces: 主 spec 包含 `kind` 字段与按 kind 过滤能力。

- [ ] **Step 1: 在文件头部追加 kind 字段说明**

Edit `openspec/specs/judge-image-whitelist/spec.md`，将第 11 行（`Requirement: 管理员管理镜像白名单` 内的描述行）替换为：

```
每条白名单记录包含 `image`（镜像名）、`mode`（`exact` 或 `all_versions`）、`kind`（`evaluator` 或 `solution`，必填）、`description`（介绍文案）。
```

原句：
```
每条白名单记录包含 `image`（镜像名）、`mode`（`exact` 或 `all_versions`）、`description`（介绍文案）。
```

- [ ] **Step 2: 在 Requirement 内追加 4 个 kind 相关 scenarios**

在 `Requirement: 管理员管理镜像白名单` 内、`Scenario: 管理员添加全版本镜像` **之前**，插入以下 4 个 scenarios（来自 delta spec lines 14-26）：

```markdown
#### Scenario: 管理员添加 Evaluator 镜像

- **WHEN** 管理员发送 `POST /api/v1/admin/judge-images`，携带 `{ "image": "noj-evaluator-python:3.12", "mode": "exact", "kind": "evaluator", "description": "Evaluator Python 3.12 评测环境" }`
- **THEN** 系统创建白名单记录，`kind='evaluator'`，仅 `noj-evaluator-python:3.12` 精确匹配该条目，返回 HTTP 201

#### Scenario: 管理员添加 Solution 镜像

- **WHEN** 管理员发送 `POST /api/v1/admin/judge-images`，携带 `{ "image": "noj-solution-python:3.12", "mode": "exact", "kind": "solution", "description": "Solution Python 3.12 评测环境" }`
- **THEN** 系统创建白名单记录，`kind='solution'`，返回 HTTP 201

#### Scenario: kind 字段缺失被拒

- **WHEN** 管理员发送 `POST /api/v1/admin/judge-images`，缺少 `kind` 字段
- **THEN** 系统返回 HTTP 400，提示 kind 仅允许 `evaluator` / `solution`，必填

#### Scenario: kind 字段非法值被拒

- **WHEN** 管理员发送 `POST /api/v1/admin/judge-images`，携带 `kind: "worker"`
- **THEN** 系统返回 HTTP 400，提示 kind 仅允许 `evaluator` / `solution`
```

同时把现有的 `Scenario: 管理员添加精确版本镜像` 末尾追加一行 `kind: "evaluator"` 字段示例（与新增场景对齐）。

- [ ] **Step 3: 重写 `Requirement: 题目创建/更新时校验镜像白名单` 整段**

将 `Requirement: 题目创建/更新时校验镜像白名单` 重命名为 `Requirement: 题目创建/更新时校验镜像白名单（含 kind）`，其描述行（当前第 50 行）替换为：

```
系统 SHALL 对题目创建和更新请求中的 `runtime_config` 字段执行白名单校验，
并确保 `runtime_config` 中 Evaluator / Solution 镜像的 kind 与白名单条目一致。
白名单为空时 SHALL 拒绝所有镜像名，返回明确错误提示。
```

在该 requirement 内追加以下 scenarios（来自 delta spec lines 59-94）：

```markdown
#### Scenario: 双容器题目 Evaluator 镜像校验

- **WHEN** 白名单中存在 `exact: "noj-evaluator-python:3.12"` 且 `kind='evaluator'` 条目
- **WHEN** 用户创建双容器题目，传入 `runtime_config.evaluator.image: "noj-evaluator-python:3.12"`
- **THEN** 系统通过白名单 + kind 校验，正常创建题目
- **WHEN** 用户传入 `runtime_config.evaluator.image: "noj-solution-python:3.12"`（白名单 kind='solution'）
- **THEN** 系统返回 HTTP 400，提示 `image kind mismatch: evaluator image required`

#### Scenario: 双容器题目 Solution 镜像校验

- **WHEN** 白名单中存在 `exact: "noj-solution-python:3.12"` 且 `kind='solution'` 条目
- **WHEN** 用户创建双容器题目，传入 `runtime_config.solution.image: "noj-solution-python:3.12"`
- **THEN** 系统通过白名单 + kind 校验，正常创建题目
- **WHEN** 用户传入 `runtime_config.solution.image: "noj-evaluator-python:3.12"`（白名单 kind='evaluator'）
- **THEN** 系统返回 HTTP 400，提示 `image kind mismatch: solution image required`

#### Scenario: 更新题目时校验镜像（runtime_config）

- **WHEN** 白名单非空，用户编辑题目时修改 `runtime_config` 中 Evaluator / Solution 镜像为不在白名单中的值
- **THEN** 系统返回 HTTP 400，拒绝更新
```

- [ ] **Step 4: 重写 `Requirement: 公开镜像列表 API` 为"按 kind 过滤"**

将 `Requirement: 公开镜像列表 API` 重命名为 `Requirement: 公开镜像列表 API（按 kind 过滤）`，其描述行替换为：

```
系统 SHALL 提供 `GET /api/v1/judge-images` 端点（无需认证），返回所有白名单镜像
记录供题目编辑器使用。客户端可按 `kind` 查询参数过滤。
```

在该 requirement 内追加：

```markdown
#### Scenario: 按 kind 过滤

- **WHEN** 客户端发送 `GET /api/v1/judge-images?kind=evaluator`
- **THEN** 系统仅返回 `kind='evaluator'` 的白名单记录
```

同时把 `Scenario: 获取可用镜像列表` 的响应字段追加 `kind`。

- [ ] **Step 5: 新增 `Requirement: get_image_allowlist RPC 响应升级`**

在文件末尾（`Requirement: 全版本模式安全警告` 之后，或文件最末）追加：

```markdown
### Requirement: get_image_allowlist RPC 响应升级

系统 SHALL 在 `get_image_allowlist` RPC 响应中返回每条镜像的 `kind` 字段，
供 judge 启动时按 kind 分别预热容器池（双容器模式下仅 `evaluator` kind 入池，
`solution` kind 仅记录不下发容器）。

#### Scenario: RPC 响应包含 kind

- **WHEN** judge 发送 `get_image_allowlist` RPC 请求
- **THEN** core 查询 `judge_images` 表中所有记录
- **THEN** core 返回 JSON 数组，每项包含 `image`、`kind`（`evaluator` / `solution`）、`mode`（`exact` / `all_versions`）

#### Scenario: 历史数据迁移（kind 默认值）

- **WHEN** Drizzle 迁移 `0018_judge_images_kind.sql` 首次执行
- **THEN** 历史记录 `kind` 默认填充为 `evaluator`
- **THEN** admin 在迁移后需手动调整 `noj-solution-*` 镜像的 kind 为 `solution`
```

- [ ] **Step 6: 验证主 spec 完整性**

Run: `grep -c '^### Requirement:' openspec/specs/judge-image-whitelist/spec.md`
Expected: 输出 `5`（管理员管理镜像白名单 + 题目创建/更新时校验镜像白名单（含 kind） + 公开镜像列表 API（按 kind 过滤） + 全版本模式安全警告 + get_image_allowlist RPC 响应升级）。

- [ ] **Step 7: Commit**

```bash
git add openspec/specs/judge-image-whitelist/spec.md
git commit -m "docs(openspec): judge-image-whitelist 主规范合并 kind 字段升级"
```

---

## Task 5: 修改 `judge-worker` 主 spec（精细拆分 + 追加 ADDED Requirements）

**Files:**
- Modify: `openspec/specs/judge-worker/spec.md`

**Interfaces:**
- Consumes: `openspec/changes/dual-container-judge/specs/judge-worker/spec.md`（ADDED Requirements 源，199 行）。
- Produces: 主 spec 反映双容器唯一路径。

这是最大的修改任务。逐 scenario 操作。

- [ ] **Step 1: 删除 `Requirement: 并发控制` 整段（lines 148-162）**

Edit `openspec/specs/judge-worker/spec.md`，从 `### Requirement: 并发控制` 标题开始到下一个 `### Requirement:` 之前的所有内容，整段删除。

- [ ] **Step 2: 精简 `Requirement: 评测编排` — 删除单容器 exec scenarios**

保留：
- `Scenario: 评测成功（s3 模式）`
- `Scenario: 评测成功（base64 模式）`
- `Scenario: 无支持包时跳过`
- `Scenario: 下载/解码失败返回 SystemError`
- `Scenario: 完整性校验失败`

删除：
- `Scenario: 评测超时`（exec > time_limit_ms）
- `Scenario: 评测脚本无有效输出`
- `Scenario: 用户代码运行时错误`
- `Scenario: 容器内存超限`
- `Scenario: 容器创建失败（镜像问题）`

改写：
- `Scenario: 返回资源消耗数据` → 改为：

```markdown
#### Scenario: 返回资源消耗数据（双容器）

- **WHEN** 评测完成（正常或异常）
- **THEN** `JudgeResult.time_ms` 包含 Evaluator 容器总执行时间（含全部 SDK 调用）
- **THEN** `JudgeResult.memory_kb` 包含 Evaluator RSS 峰值
- **THEN** Solution OOM 不计入上述字段（单独由 ADDED Requirements 中的 Solution OOM scenario 覆盖）
- **WHEN** 资源测量失败（如 cgroup 不可读）
- **THEN** `time_ms` 和 `memory_kb` 返回 0
```

- [ ] **Step 3: 在 `Requirement: 评测编排` 内追加 zip 解压防护场景**

由于支持包 zip 解压防护已移出 `container-pool` 概念，改为 `Requirement: 评测编排` 内的 scenario（来源：`container-pool/spec.md` §"Requirement: 支持包完整性校验"）：

```markdown
#### Scenario: zip 解压防护

- **WHEN** 解压支持包 zip
- **THEN** 解压后总大小不超过 `POOL_MAX_ARCHIVE_MB`
- **THEN** 拒绝 overlapping entries（相同路径重复）
- **THEN** 拒绝包含 `..` 组件的 entry
- **THEN** 单文件大小不超过 `POOL_MAX_ARCHIVE_MB`
```

- [ ] **Step 4: 在主 spec 末尾追加 7 个 ADDED Requirements**

将以下内容（来自 `openspec/changes/dual-container-judge/specs/judge-worker/spec.md` 全部 ADDED Requirements，lines 1-198，但移除原"兼容性回退"段）追加到 `openspec/specs/judge-worker/spec.md` 末尾（在 `Requirement: 缓存淘汰（LRU）` 之后）：

```markdown
### Requirement: 双容器评测编排（dual mode）

系统 SHALL 支持按题目一次任务启动 Evaluator + Solution 两个容器，按 NDJSON
协议在两个容器之间转发调用消息。

#### Scenario: 启动 Evaluator + Solution 双容器

- **WHEN** JudgeTask 含 `runtime_config`
- **THEN** judge 启动 Evaluator 容器（网络隔离、不立即执行 evaluate.py）
- **THEN** judge 通过 `docker exec tar xf` 注入支持包文件到 Evaluator 容器的 `/workspace` 目录
- **THEN** judge 启动 Solution 容器（无网络、无支持包、不传 Evaluator 环境变量）
- **THEN** judge 通过 docker exec 在 Evaluator 容器内运行 `runtime_config.evaluator.command`
- **THEN** judge 通过 docker exec 在 Solution 容器内运行 `python3 -m noj_solution_sdk.host --entry <solution.entry>`
- **THEN** Solution host 启动后 5 秒内必须发送 `ready` 帧，否则判 SystemError

#### Scenario: NDJSON 帧转发（Evaluator → Solution）

- **WHEN** Evaluator SDK 调用 `SolutionRunner.call(fn, ...args)`
- **THEN** SDK 通过 stdout 输出一行 NDJSON 帧 `{type: 'call', id, fn, args}`
- **THEN** judge 读取 evaluator exec stdout 中的 NDJSON 帧，原样转发到 solution host stdin
- **THEN** Solution host 处理后通过 stdout 输出 `result` 或 `error` 帧
- **THEN** judge 读取 solution exec stdout 中的响应帧，原样回写到 evaluator exec stdin
- **THEN** SDK 从 stdin 读到响应帧后阻塞调用返回

#### Scenario: 多次调用复用同一 Solution host

- **WHEN** 一次评测内多次调用 `SolutionRunner.call()`
- **THEN** 全部调用复用同一 Solution host 进程（persistent 模式）
- **THEN** Solution host 内的全局状态在调用之间持续存在
- **WHEN** `runner.restart()` 被调用
- **THEN** judge 关闭旧 Solution host 进程，启动新 host 进程

#### Scenario: 单次调用超时（call_timeout_ms）

- **WHEN** 某次 `runner.call()` 超过 `runtime_config.solution.call_timeout_ms`
- **THEN** judge 停止向 solution host stdin 写入
- **THEN** SDK 收到 `code: 'Timeout'` 错误帧
- **THEN** Solution host 进程继续运行（不退出）

#### Scenario: Evaluator 总时间超时

- **WHEN** Evaluator 容器总执行时间超过 `runtime_config.evaluator.time_limit_ms`
- **THEN** judge `docker stop -t kill_grace_secs` Evaluator 容器
- **THEN** judge `docker kill` Evaluator 容器（如未退）
- **THEN** judge `docker rm -f` Solution 容器
- **THEN** JudgeResult.status = 'TimeLimitExceeded'

#### Scenario: Evaluator OOM

- **WHEN** Evaluator 容器因 RSS 超限被 Docker kill（退出码 137）
- **THEN** JudgeResult.status = 'MemoryLimitExceeded'

#### Scenario: Solution OOM

- **WHEN** Solution 容器 RSS 超 `runtime_config.solution.memory_limit_mb`
- **THEN** Solution host 守护进程触发 SystemError
- **THEN** judge 关闭 Solution 容器 + Evaluator 容器
- **THEN** JudgeResult.status = 'SystemError'

### Requirement: NDJSON 协议帧类型与字段

系统 SHALL 在 Evaluator / Solution 容器之间传输 NDJSON 帧，定义统一的帧类型与字段。

#### Scenario: 帧类型枚举

- **WHEN** 任何容器发送 NDJSON 帧
- **THEN** `type` 字段必须是下列之一：`ready` / `call` / `result` / `error` / `log` / `shutdown`
- **WHEN** `type` 为非法值
- **THEN** 接收方记录 warn 日志并丢弃该帧

#### Scenario: 错误码枚举

- **WHEN** `type === 'error'`
- **THEN** `code` 字段必须是下列之一：`Timeout` / `NotFound` / `Exception` / `SystemError` / `Rejected`

#### Scenario: 类型安全序列化

- **WHEN** Evaluator SDK 序列化 `runner.call()` 参数
- **THEN** 仅接受 `None` / `bool` / `int` / `float` / `str` / `bytes` / `list` / `dict` 七种类型
- **WHEN** 参数包含其他类型（如自定义类、函数、模块、socket、生成器）
- **THEN** Solution host 抛 `code: 'Rejected'`，host 进程继续运行

#### Scenario: Trace 路径清洗

- **WHEN** Solution host 格式化用户代码异常的 traceback
- **THEN** 仅保留文件 basename + 行号 + 类名 + 消息
- **THEN** 剥离所有绝对路径（不暴露 SDK 安装路径或容器镜像 layout）

### Requirement: Log 消息限额

系统 SHALL 对 Solution host 上报的 `log` 帧实施双限额，防止日志 spam 拖慢评测
或撑爆 JudgeResult。

#### Scenario: 单条 log 限额

- **WHEN** Solution host 发送 `log` 帧
- **THEN** `data` 字段长度 ≤ 64 KiB
- **WHEN** 超过 64 KiB
- **THEN** 截断为前 64 KiB + `\n<truncated>\n`

#### Scenario: 累计 log 限额

- **WHEN** 单次评测累计 `log.data` 字节数 ≤ 1 MiB
- **THEN** 所有 log 帧正常上报
- **WHEN** 累计超过 1 MiB
- **THEN** 后续 log 帧被 judge 丢弃
- **THEN** JudgeResult.details.logs_dropped 字段记录丢弃数量

#### Scenario: Log 不进入 output 字段

- **WHEN** log 帧累计并入 JudgeResult
- **THEN** 仅写入 `details.logs[]`，不进入 `output` 字段
- **THEN** `details.logs` 单独 8 KiB 截断

### Requirement: 输出缓冲约定

系统 SHALL 要求 SDK / host 启动时配置 line buffering，避免 NDJSON 帧在管道
block buffering 下卡住。

#### Scenario: Solution host line buffering

- **WHEN** Solution host 启动
- **THEN** host 调用 `sys.stdout.reconfigure(line_buffering=True)`
- **THEN** host 调用 `sys.stderr.reconfigure(line_buffering=True)`

#### Scenario: Evaluator SDK stdout 纯净

- **WHEN** `noj_evaluator_sdk.configure_logging()` 被调用
- **THEN** 所有 SDK 内部 print / logging 重定向到 stderr
- **THEN** evaluate.py 自身 print 仍可能污染 stdout（设计选择：不强制重定向，文档警示）

### Requirement: 容器清理 RAII 契约

系统 SHALL 使用 RAII 保证双容器在所有错误场景下都被清理。

#### Scenario: DualContainer Drop 顺序

- **WHEN** DualContainer 被 drop（无论正常路径还是 panic）
- **THEN** 先 `docker rm -f` Solution 容器
- **THEN** 后 `docker rm -f` Evaluator 容器
- **THEN** 中间任何步骤抛错不阻止后续清理
- **THEN** 临时目录与下载缓存被清理

#### Scenario: 8 种错误场景必测

- **WHEN** orchestrator 单元/集成测试运行
- **THEN** 覆盖以下 8 种场景的清理正确性：evaluator 启动失败、solution 启动失败、evaluator exec 启动失败、solution host 未 ready、SDK 调用超时、SDK 反序列化错误、evaluator 总超时、Solution OOM

### Requirement: 时间层级关系

系统 SHALL 明确 Evaluator / Solution / SDK 调用三层时间约束的语义。

#### Scenario: 时间约束分层

- **WHEN** dual mode 评测启动
- **THEN** `runtime_config.solution.call_timeout_ms` 约束单次 `runner.call()`
- **THEN** `runtime_config.evaluator.time_limit_ms` 约束 Evaluator 容器总时间（含全部 SDK 调用）
- **THEN** 评测实际总耗时 = sum(SDK 调用耗时) + overhead，且 ≤ `evaluator.time_limit_ms`
- **THEN** `result.accept/wrong_answer` 调用本身不受 `call_timeout_ms` 限制

#### Scenario: 单次超时不影响 host

- **WHEN** 单次 `runner.call()` 超 `call_timeout_ms`
- **THEN** judge 关闭转发通道，SDK 收到 Timeout 错误
- **THEN** Solution host 进程继续运行，下一次 `runner.call()` 可正常执行

### Requirement: 镜像白名单防御（judge 侧）

系统 SHALL 在 judge 准备创建 Evaluator / Solution 容器前做最终校验，避免 TOCTOU。

#### Scenario: 镜像白名单校验（judge 防御）

- **WHEN** judge 准备创建 Evaluator / Solution 容器前
- **THEN** judge 校验本地缓存的镜像列表
- **WHEN** 镜像不在本地缓存
- **THEN** 判 SystemError + 提示 `image_not_in_local_cache`

### Requirement: runtime_config 必填校验

系统 SHALL 在题目创建/更新 API 与提交流程中要求 `runtime_config` 必填，
缺字段时返回明确错误。

#### Scenario: 创建/更新缺 runtime_config 被拒

- **WHEN** admin 创建或更新题目，`runtime_config` 缺失或缺任一必填字段
- **THEN** API 返回 HTTP 400，错误信息明确指出缺失字段
```

- [ ] **Step 5: 验证主 spec 不含已删除内容**

Run: `grep -nE '^\s*### Requirement: 并发控制$' openspec/specs/judge-worker/spec.md && echo "FAIL" || echo "OK"`
Expected: 输出 `OK`（grep 找不到 = exit 1，`&&` 短路失败，`||` 走 OK 分支）。

Run: `grep -nE '评测超时|评测脚本无有效输出|用户代码运行时错误|容器内存超限|容器创建失败（镜像问题）' openspec/specs/judge-worker/spec.md`
Expected: 无输出。

- [ ] **Step 6: 验证 Requirement 列表完整**

Run: `grep -c '^### Requirement:' openspec/specs/judge-worker/spec.md`
Expected: 输出 ≥ 14（任务拉取、结果发布、JudgeTask 结构、评测编排、支持包缓存、缓存淘汰（LRU）、临时文件管理、双容器评测编排、NDJSON 协议帧类型与字段、Log 消息限额、输出缓冲约定、容器清理 RAII 契约、时间层级关系、镜像白名单防御（judge 侧）、runtime_config 必填校验）。

- [ ] **Step 7: Commit**

```bash
git add openspec/specs/judge-worker/spec.md
git commit -m "docs(openspec): judge-worker 主规范精细拆分单容器场景并追加 ADDED"
```

---

## Task 6: 归档 `container-pool` 主 spec

**Files:**
- Move: `openspec/specs/container-pool/spec.md` → `openspec/changes/archive/2026-07-25-container-pool-superseded/spec.md`
- Create: `openspec/changes/archive/2026-07-25-container-pool-superseded/README.md`

**Interfaces:**
- Consumes: 旧主 spec 文件 `openspec/specs/container-pool/spec.md`（217 行）。
- Produces: 历史归档目录 `openspec/changes/archive/2026-07-25-container-pool-superseded/`。

- [ ] **Step 1: 验证无其它主 spec 引用 container-pool**

Run: `grep -rn 'container-pool' openspec/specs/ 2>&1`
Expected: 无输出（除自身外无引用）。若有引用，先记录后再继续。

- [ ] **Step 2: 创建归档目录**

Run: `mkdir -p openspec/changes/archive/2026-07-25-container-pool-superseded`
Expected: 无输出。

- [ ] **Step 3: 用 git mv 移动 spec.md**

Run: `git mv openspec/specs/container-pool/spec.md openspec/changes/archive/2026-07-25-container-pool-superseded/spec.md`
Expected: 无输出。

- [ ] **Step 4: 删除空的 container-pool 目录**

Run: `rmdir openspec/specs/container-pool && echo OK`
Expected: 输出 `OK`。

- [ ] **Step 5: 写 README.md 说明归档缘由**

在 `openspec/changes/archive/2026-07-25-container-pool-superseded/README.md` 写入：

```markdown
# container-pool 主规范 — 已归档（2026-07-25）

本目录原为主规范 `openspec/specs/container-pool/spec.md` 的归档位置。

## 归档缘由

`container-pool` 主规范描述的 PoolManager 容器池行为（含固定池大小、
统一容器池管理、容器分配两路 Acquire、容器释放与自动回补、健康检查、
文件注入 docker cp、评测执行 docker exec、优雅关闭、容器安全加固、
并发安全与状态管理、可靠性与故障恢复、zip 完整性校验等 11 个 Requirements）

已被 OpenSpec 变更 `remove-single-container-mode`（合并到
`2026-07-25-remove-single-container-mode` 归档目录）撤销。

具体撤销动作：

- 删除整个 `noj-judge/src/pool/` 模块（PoolManager、懒回补、健康检查、文件注入）
- 移除 `JudgeMode::Single` 枚举分支
- 移除 `JudgeTask` 上的 `mode` / `judge_image` / `judge_command` 字段
- 移除 `problems` 表的 `judge_image` / `judge_command` 列
- 清理 `POOL_INITIAL_SIZE` / `POOL_MAX_SIZE` / `POOL_MIN_SIZE` /
  `POOL_IDLE_TIMEOUT` / `POOL_LABEL_PREFIX` / `POOL_MAX_ARCHIVE_MB` 等环境变量
  （保留 `POOL_MEMORY_MB` / `POOL_CPU` / `POOL_KILL_GRACE_SECONDS`，因双容器路径仍使用）
- 修复 rejudge 路径缺少 `runtime_config` 的 regression

## 当前实现

所有评测统一走 `dual::evaluate_dual()` 路径，由主规范 `judge-worker` 中的 ADDED
Requirements（特别是"双容器评测编排（dual mode）"与"容器清理 RAII 契约"）描述。

zip 完整性校验的多层防护（解压大小限制、overlapping entry 拒绝、`..` 路径拒绝、
单文件大小限制）已迁移至 `judge-worker` 主规范的 `Requirement: 评测编排`
`Scenario: zip 解压防护`。

## 归档日期

2026-07-25（与 `add-noj-docs`、`dual-container-judge`、
`remove-single-container-mode` 三个变更同期归档）。
```

- [ ] **Step 6: 验证主 specs 目录不再有 container-pool**

Run: `test -d openspec/specs/container-pool && echo "FAIL: 目录仍存在" || echo "OK"`
Expected: 输出 `OK`。

Run: `test -f openspec/changes/archive/2026-07-25-container-pool-superseded/spec.md && test -f openspec/changes/archive/2026-07-25-container-pool-superseded/README.md && echo OK`
Expected: 输出 `OK`。

- [ ] **Step 7: Commit**

```bash
git add openspec/specs/container-pool openspec/changes/archive/2026-07-25-container-pool-superseded
git commit -m "docs(openspec): 归档 container-pool 主规范（已被 remove-single-container-mode 撤销）"
```

---

## Task 7: 勾选 `dual-container-judge/tasks.md`

**Files:**
- Modify: `openspec/changes/dual-container-judge/tasks.md`

**Interfaces:**
- Consumes: 现有 `openspec/changes/dual-container-judge/tasks.md`（118 行，39 项全 [ ]）。
- Produces: 勾上 [x] 的版本，反映 PR #146/#148/#155 实际落地范围。

- [ ] **Step 1: 勾选 1.1-1.5**

Edit `openspec/changes/dual-container-judge/tasks.md`，将 §1 的 5 个 `- [ ]` 改为 `- [x]`（1.1、1.2、1.3、1.4、1.5）。

- [ ] **Step 2: 勾选 §1.5 子项**

§1.5 "SDK 单测（无 Docker）" 下的 7 个 `- [ ]` 子项，全部改为 `- [x]`。

- [ ] **Step 3: 勾选 2.1-2.5**

§2 的 5 个 `- [ ]` 改为 `- [x]`（2.1、2.2、2.3、2.4、2.5）。

- [ ] **Step 4: 勾选 §2.4 子项**

§2.4 "tests/e2e_dual_container.rs 新增 12 条测试" 下的 12 个 `- [ ]` 子项，全部改为 `- [x]`（dual_basic、dual_persistent、dual_timeout、dual_solution_exception、dual_solution_cannot_overwrite_evaluate、dual_solution_no_network、dual_solution_module_shadowing、dual_solution_read_evaluator_env、dual_solution_cannot_leak_fd、dual_evaluator_no_network、dual_legacy_fallback、dual_image_kind_mismatch）。

- [ ] **Step 5: 勾选 §2.5 子项**

§2.5 "测试辅助" 下的 1 个 `- [ ]` 子项，改为 `- [x]`。

- [ ] **Step 6: 勾选 3.1-3.9**

§3 的 9 个 `- [ ]` 改为 `- [x]`（3.1-3.9）。

- [ ] **Step 7: 勾选 §3.1 / §3.2 / §3.5 子项**

- §3.1 "Dockerfile" 下的 3 个 `- [ ]` 子项 → `- [x]`
- §3.2 "Dockerfile" 下的 3 个 `- [ ]` 子项 → `- [x]`
- §3.5 "Drizzle 迁移" 下的 2 个 `- [ ]` 子项 → `- [x]`

- [ ] **Step 8: 勾选 4.1-4.9**

§4 的 9 个 `- [ ]` 改为 `- [x]`（4.1-4.9）。

- [ ] **Step 9: 勾选 §4.3 / §4.7 / §4.9 子项**

- §4.3 "types/problems.ts" 下的 3 个 `- [ ]` 子项 → `- [x]`
- §4.4 "services/problems.ts" 下的 4 个 `- [ ]` 子项 → `- [x]`
- §4.5 "services/submissions.ts" 下的 3 个 `- [ ]` 子项 → `- [x]`
- §4.7 "admin 题目编辑表单" 下的 4 个 `- [ ]` 子项 → `- [x]`
- §4.9 "e2e/08_dual_container_judge.test.ts" 下的 3 个 `- [ ]` 子项 → `- [x]`

- [ ] **Step 10: 勾选 5.1 + 5.2；保留 5.3 / 5.4 为 [ ]**

- 5.1 "spec 增量文件落盘" 改为 `- [x]`（已落盘到 `changes/dual-container-judge/specs/`，由本批次 sync 任务完成；不改写为完全自动）
- 5.2 "`openspec archive dual-container-judge`" 改为 `- [x]`（本次操作完成）
- 5.3、5.4 **保留 `- [ ]`**：原描述为 "archive 同步时自动完成"，但本项目 sync 是 agent-driven intelligent merging 而非自动流程；本次清理为手动同步，5.3/5.4 描述的"自动完成"语义不准确，因此保留为 [ ] 并在 archive 后由人工确认一致性（已在 spec 自审与本计划 Task 5 中完成）

- [ ] **Step 11: 勾选 §6 全部**

§6 "关键检查点（每 PR 合并前必过）" 下的 7 个 `- [ ]` 子项（cargo fmt / clippy / test、deno fmt / lint / test、npm build、Docker E2E、全链路 E2E、GPG），全部改为 `- [x]`。

- [ ] **Step 12: 验证勾选统计**

Run: `echo "勾选数: $(grep -c '^- \[x\]' openspec/changes/dual-container-judge/tasks.md)" && echo "未勾选数: $(grep -c '^- \[ \]' openspec/changes/dual-container-judge/tasks.md)"`
Expected: 第一行输出一个大数（≥ 60），第二行输出 `2`（仅 5.3、5.4 保留为 [ ]）。

- [ ] **Step 13: Commit**

```bash
git add openspec/changes/dual-container-judge/tasks.md
git commit -m "docs(openspec): 勾选 dual-container-judge 已落地任务（保留 5.3/5.4）"
```

---

## Task 8: 归档三个变更目录

**Files:**
- Move: `openspec/changes/add-noj-docs/` → `openspec/changes/archive/2026-07-25-add-noj-docs/`
- Move: `openspec/changes/dual-container-judge/` → `openspec/changes/archive/2026-07-25-dual-container-judge/`
- Move: `openspec/changes/remove-single-container-mode/` → `openspec/changes/archive/2026-07-25-remove-single-container-mode/`

**Interfaces:**
- Consumes: 三个活跃变更目录。
- Produces: 三个归档目录（保留 `.openspec.yaml` manifest 与所有子目录）。

- [ ] **Step 1: 检查归档目录是否已存在**

Run: `for n in add-noj-docs dual-container-judge remove-single-container-mode; do test -d "openspec/changes/archive/2026-07-25-$n" && echo "冲突: 2026-07-25-$n 已存在"; done`
Expected: 无输出（无冲突）。若有冲突，本次停止并改为 `<YYYY-MM-DD>-<name>-v2/` 后缀。

- [ ] **Step 2: git mv add-noj-docs**

Run: `git mv openspec/changes/add-noj-docs openspec/changes/archive/2026-07-25-add-noj-docs`
Expected: 无输出。

- [ ] **Step 3: git mv dual-container-judge**

Run: `git mv openspec/changes/dual-container-judge openspec/changes/archive/2026-07-25-dual-container-judge`
Expected: 无输出。

- [ ] **Step 4: git mv remove-single-container-mode**

Run: `git mv openspec/changes/remove-single-container-mode openspec/changes/archive/2026-07-25-remove-single-container-mode`
Expected: 无输出。

- [ ] **Step 5: 验证活跃 changes/ 不再有这三个目录**

Run: `ls openspec/changes/`
Expected: 仅 `archive/` 一个目录。

- [ ] **Step 6: 验证归档目录结构对称**

Run: `for n in add-noj-docs dual-container-judge remove-single-container-mode; do d="openspec/changes/archive/2026-07-25-$n"; for f in proposal.md design.md tasks.md; do test -f "$d/$f" || echo "MISSING: $d/$f"; done; done`
Expected: 无输出（三个目录都有 proposal/design/tasks 三件套）。

Run: `test -d openspec/changes/archive/2026-07-25-dual-container-judge/specs && echo "specs/ OK"`
Expected: 输出 `specs/ OK`（dual-container-judge 独有 specs/ 子目录）。

- [ ] **Step 7: Commit**

```bash
git add openspec/changes
git commit -m "docs(openspec): 归档 add-noj-docs/dual-container-judge/remove-single-container-mode"
```

---

## Task 9: 最终验证与总结 commit

**Files:**（无新建/修改）

**Interfaces:** 跨所有前序任务的最终验收。

- [ ] **Step 1: 验证 changes/ 下无 active 变更**

Run: `ls openspec/changes/ && echo "---" && ls openspec/changes/*/ 2>&1 | head -20`
Expected: 第一个 `ls` 仅输出 `archive`；第二个 `ls` 因通配不匹配 active 目录而无输出（或仅 archive 子目录）。

- [ ] **Step 2: 验证主 specs 包含所有目标规范**

Run: `for s in judge-worker judge-image-whitelist problem-runtime-config; do test -f "openspec/specs/$s/spec.md" && echo "$s OK" || echo "$s MISSING"; done`
Expected: 三行 OK。

Run: `test -d openspec/specs/container-pool && echo "FAIL: container-pool 仍存在" || echo "container-pool 归档 OK"`
Expected: 输出 `container-pool 归档 OK`。

- [ ] **Step 3: 验证双容器 ADDED Requirements 在主 spec 中**

Run: `grep -c '^### Requirement: \(双容器评测编排\|NDJSON 协议帧类型与字段\|Log 消息限额\|输出缓冲约定\|容器清理 RAII 契约\|时间层级关系\|镜像白名单防御\|runtime_config 必填校验\)' openspec/specs/judge-worker/spec.md`
Expected: 输出 `8`。

- [ ] **Step 4: 验证镜像白名单 kind 已合并**

Run: `grep -c '^### Requirement: \(管理员管理镜像白名单\|题目创建/更新时校验镜像白名单（含 kind）\|公开镜像列表 API（按 kind 过滤）\|全版本模式安全警告\|get_image_allowlist RPC 响应升级\)' openspec/specs/judge-image-whitelist/spec.md`
Expected: 输出 `5`。

- [ ] **Step 5: 验证 problem-runtime-config 无冲突场景**

Run: `grep -nE '清空.*回退.*单容器|IS NULL.*走单容器|JudgeMode.*Single' openspec/specs/problem-runtime-config/spec.md && echo "FAIL" || echo "OK"`
Expected: 输出 `OK`。

- [ ] **Step 6: 验证 judge-worker 不含并发控制 requirement**

Run: `grep -nE '^\s*### Requirement: 并发控制$' openspec/specs/judge-worker/spec.md && echo "FAIL" || echo "OK"`
Expected: 输出 `OK`。

- [ ] **Step 7: 验证未触动运行时模块**

Run: `git log --name-only --oneline openspec/ 2>&1 | grep -vE '^(openspec/|docs/superpowers/|commit [a-f0-9]+|Author|Date|\s*$|Merge)' | sort -u`
Expected: 输出仅 `openspec/`、`docs/superpowers/specs/`、`docs/superpowers/plans/` 三个目录的文件。无 noj-core / noj-ui / noj-judge 文件改动。

- [ ] **Step 8: 查看整体 diff 摘要**

Run: `git log --oneline openspec/ | head -15`
Expected: 看到至少 8 个 commit（Task 1-8 每个一 commit + 本批次 spec/plan 之前的 commit）。

- [ ] **Step 9: 最终推送（如需要）**

如果用户希望推到远程：

```bash
jj git push  # 或 git push
```

否则本地 commit 完成即可。

---

## 自审记录

**1. Spec 覆盖：**
- Decision 1 → Task 1 ✓
- Decision 2 → Task 3/4/5/8 顺序 ✓
- Decision 3 → Task 6 ✓
- Decision 4 → Task 5（最复杂的拆分） ✓
- Decision 5 → Task 4 ✓
- Decision 6 → Task 3 ✓
- Decision 7 → Task 7 ✓
- Decision 8 → Task 2 ✓
- 5 步执行计划 → Task 1-9 ✓

**2. 占位符扫描：** 无 TBD/TODO/`fill in`/`implement later`/`类似 Task N` 出现。每个 task 都给完整文件内容或精确 diff。

**3. 类型一致性：** OpenSpec 不涉及类型；archive 命名 `2026-07-25-<name>/` 在 Task 6、8、9 中一致使用。