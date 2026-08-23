## Purpose

定义 CI 工作流规范，确保代码质量检查、构建和测试流程的一致性与可靠性。

## Requirements

### Requirement: CI 工作流与 noj-ui Deno 运行时一致

CI SHALL 使用 Deno 构建和检查 noj-ui，与开发阶段的运行时保持一致。

#### Scenario: UI 构建使用 Deno

- **WHEN** CI 执行 noj-ui 构建
- **THEN** 使用 `denoland/setup-deno@v2` 安装 Deno
- **THEN** 执行 `deno install` 安装依赖
- **THEN** 执行 `deno task build` 构建项目
- **THEN** 不应依赖 `actions/setup-node@v4` 或 `npm` 命令

### Requirement: CI Job 独立拆分

CI SHALL 将代码质量检查、测试与构建拆分为职责清晰的 Job，利用 GitHub
Actions 原生并行能力；冗余的重复 Job SHALL 合并以避免重复编译与缓存
key 竞争。

原独立的 `core-fmt` / `core-lint` / `judge-fmt` / `judge-clippy` /
`judge-test` Job 已 REMOVED（2026-08 起）：
- `core-fmt` / `core-lint` 并入 `core-quick-check`（fmt + lint + typecheck 一体）
- `judge-fmt` / `judge-clippy` / `judge-test` 并入 `judge-check`（共享
  target 目录只编译一次，见 `ci-pipeline-efficiency` 规范"Rust job 合并
  为 judge-check 单 job"）

`judge-e2e` 从仅 `workflow_dispatch` 改为默认 push + PR + manual 全跑。

#### Scenario: 冗余 job 不再存在

- **WHEN** CI 运行
- **THEN** `ci.yml` jobs 为：changes、core-quick-check、core-smoke、
  core-test-unit、core-test-db、core-perf、ui-check、judge-check、judge-e2e
- **THEN** 不存在独立的 `core-fmt` / `core-lint` / `judge-fmt` /
  `judge-clippy` / `judge-test` job

#### Scenario: core-quick-check 承担静态检查

- **WHEN** CI 运行
- **THEN** `core-quick-check` Job 依次执行 `deno fmt --check`、
  `deno lint`、`deno check`（src 下全部 .ts）
- **THEN** 该 Job 不依赖 PostgreSQL 或 Redis 服务

#### Scenario: judge-check 承担 Rust 静态检查与单测

- **WHEN** CI 运行
- **THEN** `judge-check` Job 依次执行 `cargo fmt --all --check`、
  `cargo clippy --all-targets -- -D warnings`、`cargo nextest run --all-targets`
- **THEN** 该 Job 不包含单独的 `cargo build` 步骤（clippy 已编译全部目标）

### Requirement: 单步失败准确反映

CI SHALL 确保每个 Job 的退出码被正确捕获，任何步骤失败都导致对应 Job 失败。

#### Scenario: fmt 失败导致 core-quick-check Job 失败

- **WHEN** `deno fmt --check` 返回非零退出码
- **THEN** `core-quick-check` Job 标记为失败
- **THEN** PR 状态显示该检查未通过

#### Scenario: lint 失败不影响测试

- **WHEN** `deno lint` 返回非零退出码
- **THEN** 仅 `core-quick-check` Job 标记为失败
- **THEN** `core-test-unit` / `core-test-db` Job 可以独立完成（如果只触发 lint 变更）

#### Scenario: 并行组失败准确传播

- **WHEN** `judge-e2e` / `judge-sandbox` 的任一并行组（run_group）内某个
  `cargo test --test <target>` 返回非零
- **THEN** 对应组 `wait` 捕获非零并置 `fail=1`
- **THEN** 步骤最终以 `exit 1` 结束，Job 标记为失败

### Requirement: 性能基准数据清理与外部数据库保护

系统 SHALL 在搜索性能基准结束后默认清理其测试数据。使用外部 PostgreSQL 运行性能基准 MUST 显式设置确认变量；设置保留变量时系统 SHALL 跳过清理以支持人工分析。

#### Scenario: 默认清理

- **WHEN** 性能基准成功或失败结束且未设置保留变量
- **THEN** 系统清理性能基准创建的测试数据

#### Scenario: 外部数据库确认

- **WHEN** 性能基准检测到外部 PostgreSQL 连接但未设置确认变量
- **THEN** 系统拒绝运行并提示设置确认变量

#### Scenario: 保留性能数据

- **WHEN** 运行性能基准时设置 `NOJ_PERF_KEEP_DATA=1`
- **THEN** 系统在结束时保留测试数据
