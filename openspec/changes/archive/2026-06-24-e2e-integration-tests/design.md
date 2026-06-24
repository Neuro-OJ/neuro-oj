## Context

目前 noj-core 和 noj-judge 各自有单元测试，但缺少跨模块的全链路集成测试。Issue #52 要求在真实的 Docker 编排环境中验证提交流程的完整性。现有 `openspec/specs/judge-e2e-test/spec.md` 已覆盖 MQ 消息验证和结果消费者测试，但缺少完整的 Docker Compose 栈测试。

**当前已有基础设施：**
- `docker-compose.e2e.yml` 已存在，但仅含 PostgreSQL + Redis
- `scripts/e2e/setup.sh` 手动启动 noj-core（`deno run ... &`）、noj-judge（`cargo build + nohup`）和 noj-ui（`npm run dev &`）为后台进程
- `scripts/e2e/smoke.mjs` 通过 Playwright 对 noj-ui 做冒烟测试（登录→提交→结果）
- `.github/workflows/e2e.yml` 也手动启动后台进程运行测试

**noj-judge 已有 19 个 Rust E2E 测试**，通过 `#[ignore]` + `NOJ_RUN_E2E=1` 门控，测试 Docker 容器生命周期、OOM、网络隔离、安全挂载等低层沙箱行为。这些与 Issue #52 的管道测试**正交**，保留不动。

## Goals / Non-Goals

**Goals:**
- **扩展**已有 `docker-compose.e2e.yml`，加入 noj-core、noj-judge 服务，实现一键启动完整评测栈
- 新增独立 `noj-tests/` 包（Deno TypeScript），专门存放跨模块管道 E2E 测试
- TypeScript 测试脚本通过 REST API 自动提交流程并轮询结果
- 覆盖 5 种场景：Accepted、Wrong Answer、TLE、MQ 可靠性、无效消息容错
- **迁移** `scripts/e2e/setup.sh`/`teardown.sh` 从后台进程改为 `docker compose up/down`
- **删除** `scripts/e2e/smoke.mjs`，从 `noj-ui/package.json` 移除 Playwright
- 测试可重复执行，结束后清理所有资源（容器、MQ 消息、数据库记录）
- 通过 `NOJ_RUN_E2E=1` 环境变量门控，默认跳过

**Non-Goals:**
- 不涉及 noj-ui 前端测试 API 级测试已覆盖完整管道，UI 冒烟测试被移除
- 不替代现有单元测试
- 不替代 noj-judge 现有的 19 个 Rust E2E 测试（低层 Docker 行为测试）
- 不在 CI 中默认运行（仅手动或定时触发）

## Decisions

### 1. Docker Compose 架构：扩展已有 `docker-compose.e2e.yml`

**选择：** 扩展已有 `docker-compose.e2e.yml`（当前仅含 PostgreSQL + Redis），加入 noj-core 和 noj-judge 服务

- 开发用 `docker-compose.yml` 仅含 PostgreSQL + Redis，不包含 noj-core 和 noj-judge
- E2E 测试需要完整的评测栈，用独立的 compose 文件隔离职责
- 新增 `noj-core` 服务：使用 `Dockerfile`（新建）基于 `denoland/deno` 镜像构建 noj-core，执行 migrate + seed 后启动 API 服务
- 新增 `noj-judge` 服务：使用 `noj-judge/docker/python/Dockerfile` 作为评测镜像，使用 Rust 镜像编译 noj-judge 二进制后运行
- 取消 noj-ui 服务：API 级 E2E 测试不需要 UI

### 2. 测试脚本语言：TypeScript（Deno）vs Shell vs Python

**选择：** Deno TypeScript（与 noj-core 一致）

- 与 noj-core 共享类型定义（JudgeTask、JudgeResult）
- 无需额外运行时依赖（Deno 已配置）
- 可直接复用 noj-core 的 API 客户端模式

### 3. 测试用例门控方式

**选择：** 环境变量 `NOJ_RUN_E2E=1`

- 与现有 `judge-e2e-test` spec 一致的门控方式
- `deno test --allow-env --allow-net` 仅在该变量设置时执行 E2E 测试
- 默认跳过，不影响日常开发测试

### 4. 容器清理策略

**选择：** 测试脚本启动/停止 compose，而非依赖外部编排

- 测试入口脚本负责 `docker compose up -d` 和 `docker compose down -v`
- `down -v` 确保卷（MQ 消息、数据库）被彻底清理
- 提供 `--no-cleanup` 选项用于调试

### 5. 评测镜像构建

**选择：** 使用 noj-judge 已有的 Dockerfile，在测试启动前构建

- `docker compose build` 在 `up` 前自动构建 judge 镜像
- 使用 noj-judge 的 Python 评测镜像作为标准测试镜像
- 测试代码自带一个简单的评测支持包（含 evaluate.py 和测试用例）

### 6. 测试包位置：独立 `noj-tests/` vs 内嵌在 `noj-core/` 或 `noj-judge/`

**选择：** 新建 `noj-tests/` 独立包（Deno TypeScript）

- 与生产模块解耦：不污染 noj-core/judge 的依赖和配置
- 可独立运行：`cd noj-tests && deno task test:e2e`
- 可共享类型：从 `noj-core/` import JudgeTask、JudgeResult 等类型
- 与 noj-judge 现有 Rust E2E 测试互补：前者测 Docker 沙箱行为，后者测跨模块管道
- 可选未来扩展现有 Rust 测试的 `#[serial_test]` 隔离模式

### 7. noj-ui 测试策略：移除现有冒烟测试

**选择：** 删除 `scripts/e2e/smoke.mjs`，从 `noj-ui/package.json` 移除 Playwright 依赖，CI 中移除相关步骤

- API 级测试已覆盖完整管道：提交→MQ→Judge→结果→数据库持久化
- 现有 `smoke.mjs` 同时使用了 Playwright（浏览器 UI）和 fetch（API），测试意图混杂——UI 部分（登录、页面跳转）对管道覆盖无增量收益
- Playwright 仅用于这一个冒烟测试，移除后 noj-ui 不再需要浏览器自动化依赖
- UI 交互适合上线前人工回归测试或独立的 visual regression 流程

### 8. 迁移现有脚本：从后台进程到 Docker Compose

**选择：** 重写 `scripts/e2e/setup.sh` 和 `scripts/e2e/teardown.sh`，从手动启动后台进程改为 `docker compose up/down`

**现状（后台进程模式）：**
- `deno run src/main.ts &` 启动 noj-core
- `cargo build --release && nohup ./noj-judge &` 启动 noj-judge
- `npm run dev &` 启动 noj-ui
- PID 文件管理、手动健康检查

**改为（Docker Compose 模式）：**
- `docker compose -f docker-compose.e2e.yml up -d` 一键启动
- `docker compose -f docker-compose.e2e.yml down -v` 一键清理
- 服务依赖和健康检查由 Docker Compose 的 depends_on + healthcheck 处理
- 构建通过 compose 的 build 指令自动触发

**迁移收益：**
- 消除后台进程管理复杂性（PID 文件、日志重定向、竞争条件）
- 环境一致性：本地与 CI 使用相同的 Docker Compose 配置
- 减少 `scripts/e2e/` 中约 60% 的 Shell 代码

### 9. CI 工作流简化

**选择：** `.github/workflows/e2e.yml` 移除 noj-ui 冒烟测试相关步骤

- 删除：Playwright 安装、noj-ui 启动、smoke.mjs 执行
- 保留：noj-core API E2E 测试、noj-judge Rust E2E 测试
- 核心启动改为 Docker Compose（而非手动 `nohup deno run ... &`）

## Risks / Trade-offs

- **[Docker-in-Docker 不可用]** → 评测容器在 host Docker 中运行，通过 volume 映射支持包
- **[端口冲突]** → 所有服务端口可通 `E2E_*` 环境变量覆盖
- **[测试耗时]** → 全栈启动约 10-30 秒，每个测试用例约 5-15 秒。设 `test:e2e` 独立任务，不影响日常测试
- **[残留资源]** → `down -v` 处理正常情况；异常退出时需手动 `docker compose -f docker-compose.e2e.yml down -v`
