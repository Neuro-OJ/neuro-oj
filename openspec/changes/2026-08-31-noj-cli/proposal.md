## Why

当前部署/运维脚本分散在 `setup.sh`、`scripts/deploy/*.sh`、`noj`、`scripts/dev/devtool.sh` 等多个入口，命令入口多、职责边界不清晰，配置同时存在于 `.env.prod`、`.env.dev`、`.env.judge` 等文件中，与部署元数据职责重叠。用户需要一套统一、可发现、可测试的 CLI 来覆盖服务器检测、开发部署、生产部署和生产运维。

## What Changes

- **新增 `noj-cli`**：Deno + TypeScript 编译的运维/编排 CLI，统一命令入口。
- **新增 `noj-server`**：由 noj-core 编译出的 API 服务二进制；开发时直接运行，生产时内嵌进 Docker 镜像。
- **镜像改名**：`ghcr.io/neuro-oj/noj-core` → `ghcr.io/neuro-oj/noj-server`。
- **配置模型改为 JSON**：`noj-deploy.json`（非敏感）+ `noj-secrets.json`（敏感），不再使用独立 `.env` 文件作为配置载体。
- **引入状态机**：`uninitialized` / `stopped` / `running` / `partial` / `error`，避免重复启动/重复关闭。
- **命令分层**：
  - `doctor`：环境检测
  - `deploy init/up/down/restart/status`：部署
  - `maintain logs/backup/restore/verify/reset/config`：生产运维
  - `run-server`：直接运行 noj-server
  - `version`
- **备份格式升级**：单个 `.nojbackup` 加密归档，`zstd` 压缩 + SHA-256 校验 + GPG 对称 AES-256 加密。
- **废弃旧脚本**：`setup.sh` 仅保留为下载/校验 `noj-cli` 的薄引导；`scripts/deploy/*.sh`、`noj`、`scripts/dev/devtool.sh` 不再作为新入口。

## Capabilities

### New Capabilities

- `noj-cli`: 统一部署与运维 CLI — doctor、deploy、maintain、run-server、version。
- `noj-server`: noj-core 编译产物 — 开发直跑二进制 + 生产 Docker 镜像。
- `deploy-metadata-json`: 部署元数据模型 — `noj-deploy.json` + `noj-secrets.json`，全局 env + 组件 env + 占位符注入。
- `deploy-state-machine`: 部署状态机 — 避免重复启停，状态持久化到元数据。
- `deploy-tui`: 配置引导 TUI — dev/prod 模式表单。
- `maintain-logs`: 混合日志 — 多模块彩色前缀输出。
- `maintain-backup-archive`: 备份归档 — zstd + SHA-256 + GPG 对称加密的 `.nojbackup` 单文件格式。

### Modified Capabilities

- `one-command-deployment`: `setup.sh` 从“下载 bootstrap 并执行完整安装”改为“下载/校验 noj-cli 的薄引导”。
- `production-cli`: `noj` 命令被 `noj-cli` 取代。
- `standalone-deploy-bootstrap`: bootstrap 逻辑并入 `noj-cli`，不再单独维护 shell bootstrap。
- `production-deployment`: 生产部署入口改为 `noj-cli deploy`，配置载体从 `.env.prod` 改为 JSON。
- `devtool-process-lifecycle`: 开发编排逻辑并入 `noj-cli deploy`，进程生命周期管理保留并强化。
- `judge-standalone-deploy`: Judge 作为 `deploy` 组件统一管理，独立 Worker 使用单独 `noj-deploy.json`。
- `production-backup-recovery`: 备份产物从目录快照改为 `.nojbackup` 加密归档。

## Impact

- **新增目录**：`src/`（noj-cli 源码）、`noj-server` 构建脚本、`docs/superpowers/plans/2026-08-31-noj-cli-p*.md`。
- **修改文件**：`docker-compose.prod.yml`、`setup.sh`、README、deploy/README、noj-docs 生产部署文档。
- **废弃文件**：`scripts/deploy/*.sh`、`noj`、`scripts/dev/devtool.sh` 等旧入口。
- **CI**：新增 noj-cli / noj-server 构建与测试任务。
- **环境变量**：不再使用 `.env.prod` / `.env.dev` / `.env.judge`，改为 JSON 配置。
