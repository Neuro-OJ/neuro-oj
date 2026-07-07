## Why

noj-ui 已迁移到 Deno 运行时（开发/构建均通过 `deno task build`），但 CI 和项目文档仍沿用 Node.js 的工作流，导致：
- CI 中 UI Job 使用 `setup-node@v4` + `npm install` + `npm run build`，与实际的 Deno 工作流脱节
- 项目 README 和 CLAUDE.md 的快速启动部分仍推荐 `npm install`，可能误导新贡献者
- CI 中 Core Job 的 fmt 和 lint 在同一 step 内顺序执行，可拆分为独立 Job 提高并行度和错误可见性

## What Changes

1. **CI: UI Job 迁移到 Deno** — 将 `setup-node@v4` + `npm install` + `npm run build` 替换为 `setup-deno@v2` + `deno task build`
2. **CI: Core Job 拆分为独立 Job** — 将 `core-test` 中的 `deno fmt --check` 和 `deno lint` 拆分为两个独立 Job（`core-fmt`、`core-lint`），避免 bash 内并行导致退出码丢失的风险
3. **CI: Judge Job 拆分** — 将 `judge-check` 中的 `cargo clippy` + `cargo build` + `cargo test` 拆分为独立 Job，消除冗余的 `cargo build` 步骤
4. **文档更新** — 更新 README.md 和 CLAUDE.md，去除 Node.js 引用，更新为 Deno-only 的工作流描述
5. **E2E 描述更新** — 更新 e2e.yml 注释中的技术栈描述

**不包含**：Docker 镜像缓存、npm 缓存、tokio 特性裁剪等纯性能优化（这些可能影响 CI 正确性判断，留待后续独立考察）。

## Capabilities

### New Capabilities
- `ci-optimization`: CI 工作流重构，Job 拆分与 Deno 迁移

### Modified Capabilities
- (无 spec 级别行为变更，仅 CI 实现方式变化)

## Impact

| 文件 | 变更 |
|------|------|
| `.github/workflows/ci.yml` | UI Job 从 Node.js 换为 Deno；Core/UI/Judge Job 拆分重构 |
| `.github/workflows/e2e.yml` | 注释中的技术栈描述更新 |
| `README.md` | 去除 `Node.js >= 20` 前提要求；更新 noj-ui 技术栈描述；更新快速启动步骤 |
| `CLAUDE.md` | 更新快速启动章节，去除 `npm install` 步骤 |
