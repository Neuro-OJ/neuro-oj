## Why

CI 中全链路 E2E 测试从未触发、8 个 E2E 测试静默跳过、关键 MQ 层零测试覆盖，以及 judge 安全配置未验证——这些问题导致回归无声溜入生产。本轮修复让已有测试真正跑起来，并补齐关键盲区。

## What Changes

- 修复 `.github/workflows/e2e.yml`：恢复 E2E 触发器（push main + pull_request + workflow_dispatch）
- 修复 `noj-tests/e2e/06_pipeline.test.ts`：硬编码 `localhost:8000` → `BASE_URL`，恢复 `isJudgeAvailable()` 检测
- 重新启用 `noj-tests/e2e/05_profile.test.ts` 和 `09_checkin.test.ts` 中被 `ignore: true` 标记的 8 个测试
- 新建 `noj-judge/tests/e2e_problem_limits.rs`：验证题目的时间/内存限制实际约束 Docker 容器
- 新建 `noj-core/tests/mq/`：为 producer 和 consumer 添加单元测试（复用 fake Redis 模式）
- 扩展 `noj-judge/tests/e2e_container_pool.rs` 安全配置验证：新增 `pids_limit`、`ipc_mode`、`no-new-privileges` 断言
- 扩展 `noj-tests/e2e/06_pipeline.test.ts` 评测覆盖：新增 MLE、RE、语法错误 verdict 测试
- 延长 `pollSubmission()` 默认超时（5s → 30s）

## Capabilities

### New Capabilities
- `mq-unit-tests`: MQ 层（producer/consumer）单元测试，覆盖消息大小限制、连接状态检查、非法 JSON 跳过、重连退避

### Modified Capabilities
- `judge-e2e-test`: 新增 problem_limits 测试文件、扩展 pipeline 评测状态机（MLE/RE/语法错误）、修复 CI 触发器
- `judge-integration-test`: 扩展容器安全配置验证（pids_limit、ipc_mode、no-new-privileges 断言）

## Impact

- CI 流水线：每次 PR 和 main push 会额外运行 5-15min E2E 测试（首次恢复触发）
- noj-judge：`tests/e2e_problem_limits.rs`（新建）自动被 CI `judge-e2e` job 的 `cargo test --test e2e -- --ignored` 通配符覆盖
- noj-core：新建 `tests/mq/` 目录，引入 fake Redis 的 BRPOP/PUBLISH 支持
- noj-tests：`helper.ts` 的 `pollSubmission` 默认超时变更影响所有使用默认值的测试
