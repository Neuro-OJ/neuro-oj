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