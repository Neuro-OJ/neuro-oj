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