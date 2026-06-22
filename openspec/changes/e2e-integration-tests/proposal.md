## Why

目前 noj-core 和 noj-judge 各自有独立单元测试，但缺少跨模块的全链路集成测试。无法保障真实用户提交流程——从提交代码 → MQ 分发 → Judge 评测 → 结果回写 → 数据库持久化——的正确性。需要一套可一键运行的全链路 E2E 测试，覆盖多种评测结果和异常场景。

## What Changes

- **扩展已有 `docker-compose.e2e.yml`**：从仅含 PostgreSQL + Redis 升级为编排 noj-core + noj-judge + PostgreSQL + Redis 完整评测栈
- **新增独立 `noj-tests/` 包（Deno TypeScript）**，专门存放所有跨模块 E2E 测试
- E2E 测试脚本通过 REST API 提交代码并轮询结果
- 覆盖 5 种场景：Accepted、Wrong Answer、TLE、MQ 可靠性、无效消息容错
- noj-judge 现有 19 个 Rust 集成测试（容器生命周期、资源限制、安全隔离）**保留不动**——它们测试低层 Docker 行为，与管道测试正交
- **迁移现有的 `scripts/e2e/setup.sh` 和 `scripts/e2e/teardown.sh`**：从手动启动后台进程（`deno run &`、`./noj-judge &`）改为使用 `docker compose up -d` 一键启动
- **移除 noj-ui 冒烟测试**：删除 `scripts/e2e/smoke.mjs`，从 `noj-ui/package.json` 移除 Playwright 依赖
- **简化 CI**：`.github/workflows/e2e.yml` 移除 noj-ui 冒烟步骤，改用 Docker Compose 启动服务
- 扩展 `openspec/specs/judge-e2e-test/spec.md`，补充全栈 Docker 编排层的测试需求
- 在 `noj-tests/` 中添加 `deno task test:e2e` 任务，通过 `NOJ_RUN_E2E=1` 门控
- 确保测试可重复执行，不残留容器或 MQ 消息

## Capabilities

### New Capabilities

- `judge-e2e-test`（扩展已有 spec）：补充全栈 Docker 编排场景，包括一键启动、多结果验证、MQ 可靠性

### Modified Capabilities

- `judge-e2e-test`：现有 spec 需要扩展全栈编排场景的测试需求

## Impact

- `noj-tests/`（新增）：独立的 Deno TypeScript 包，含 deno.json、所有 E2E 测试脚本和 `test:e2e` 任务
- `docker-compose.e2e.yml`（已有，扩展）：新增 noj-core、noj-judge 服务定义和 Dockerfile
- `scripts/e2e/`：setup.sh/teardown.sh 改为基于 Docker Compose；**删除** smoke.mjs
- `noj-ui/package.json`：移除 `playwright` 开发依赖
- `.github/workflows/e2e.yml`：移除 noj-ui 冒烟步骤，简化启动流程
- `noj-judge/`：现有 Rust E2E 测试保留不动，与管道测试互补
- 依赖：Docker Compose V2，`NOJ_RUN_E2E` 环境变量门控
