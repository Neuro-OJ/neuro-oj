## Purpose

定义 CI 工作流规范，确保代码质量检查、构建和测试流程的一致性与可靠性。

## ADDED Requirements

### Requirement: CI 工作流与 noj-ui Deno 运行时一致

CI SHALL 使用 Deno 构建和检查 noj-ui，与开发阶段的运行时保持一致。

#### Scenario: UI 构建使用 Deno

- **WHEN** CI 执行 noj-ui 构建
- **THEN** 使用 `denoland/setup-deno@v2` 安装 Deno
- **THEN** 执行 `deno install` 安装依赖
- **THEN** 执行 `deno task build` 构建项目
- **THEN** 不应依赖 `actions/setup-node@v4` 或 `npm` 命令

### Requirement: CI Job 独立拆分

CI SHALL 将代码风格检查、代码质量检查和测试拆分为独立的 Job，利用 GitHub Actions 原生并行能力。

#### Scenario: noj-core fmt 独立 Job

- **WHEN** CI 运行
- **THEN** `core-fmt` Job 执行 `deno fmt --check`
- **THEN** 该 Job 不依赖 PostgreSQL 或 Redis 服务

#### Scenario: noj-core lint 独立 Job

- **WHEN** CI 运行
- **THEN** `core-lint` Job 执行 `deno lint`
- **THEN** 该 Job 不依赖 PostgreSQL 或 Redis 服务

#### Scenario: noj-judge fmt 独立 Job

- **WHEN** CI 运行
- **THEN** `judge-fmt` Job 执行 `cargo fmt --all --check`
- **THEN** 该 Job 不需要 Rust 以外的依赖

#### Scenario: noj-judge clippy 独立 Job

- **WHEN** CI 运行
- **THEN** `judge-clippy` Job 执行 `cargo clippy --all-targets -- -D warnings`
- **THEN** 该 Job 不包含单独的 `cargo build` 步骤

#### Scenario: noj-judge test 独立 Job

- **WHEN** CI 运行
- **THEN** `judge-test` Job 执行 `cargo test`
- **THEN** 该 Job 复用 clippy 编译产物

### Requirement: 单步失败准确反映

CI SHALL 确保每个 Job 的退出码被正确捕获，任何步骤失败都导致对应 Job 失败。

#### Scenario: fmt 失败导致 core-fmt Job 失败

- **WHEN** `deno fmt --check` 返回非零退出码
- **THEN** `core-fmt` Job 标记为失败
- **THEN** PR 状态显示 `core-fmt` 检查未通过

#### Scenario: lint 失败不影响 test

- **WHEN** `deno lint` 返回非零退出码
- **THEN** 仅 `core-lint` Job 标记为失败
- **THEN** `core-test` Job 可以独立完成（如果只触发 lint 变更）
