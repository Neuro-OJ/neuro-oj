## Context

现有部署/运维脚本分散，配置载体为多个 `.env` 文件，命令入口多且职责重叠。需要统一为 `noj-cli` + `noj-server` 双二进制架构，并以 JSON 作为部署元数据载体。

详细设计见 `docs/superpowers/specs/2026-08-31-noj-cli-design.md`，本文件记录 OpenSpec 层面的关键决策。

## Goals / Non-Goals

**Goals:**

- 统一命令入口：`doctor`、`deploy`、`maintain`、`run-server`、`version`
- 用 `noj-deploy.json` + `noj-secrets.json` 承载部署配置
- 引入状态机避免重复启停
- 生产以 Docker Compose 为主，开发采用“依赖 Docker + 本地进程”混合模式
- 提供 TUI 引导、混合日志、备份/恢复/校验、重置等能力
- 仅支持 `linux/amd64`

**Non-Goals:**

- 不做升级流程
- 不自动安装 Docker Engine / Docker daemon
- 不支持 ARM64
- 不兼容旧脚本/旧命令
- 不保留独立 `.env` 文件作为配置载体

## Decisions

### D1: 双二进制架构

- `noj-cli`：Deno + TypeScript 编译的运维/编排 CLI，不含业务服务逻辑。
- `noj-server`：由 noj-core 编译出的 API 服务二进制；开发时直接运行，生产时内嵌进 Docker 镜像。
- 生产镜像重命名：`ghcr.io/neuro-oj/noj-core` → `ghcr.io/neuro-oj/noj-server`。

### D2: 配置模型

- `noj-deploy.json`（非敏感，权限 644）：类型、状态、版本、组件、全局 env、反向代理配置。
- `noj-secrets.json`（敏感，权限 600）：全部密钥。
- 每个组件最终环境变量 = 全局 `env` + 组件 `env`（组件覆盖全局）。
- 组件 `env` 中的 `${KEY}` 从合并后的配置（全局 env + secrets）解析，未引用的 secrets 不注入。

### D3: 状态机

- 状态：`uninitialized` / `stopped` / `running` / `partial` / `error`。
- `deploy up` 在 `running` 时 no-op；`deploy down` 在 `stopped` 时 no-op。
- 状态写入 `noj-deploy.json`，命令执行前读取、执行后更新。

### D4: 命令分层

- `doctor`：只读环境检测。
- `deploy`：`init`（TUI）、`up`、`down`、`restart`、`status`。
- `maintain`：`logs`、`backup`、`restore`、`verify`、`reset`、`config`。
- `run-server`：直接运行 noj-server。
- `version`：版本信息。

### D5: 备份格式

- 单个 `.nojbackup` 加密归档。
- 压缩：仅 `zstd`，默认 level 15。
- 校验：SHA-256。
- 加密：GPG 对称 AES-256，口令来自 `--passphrase-file` 或 `NOJ_BACKUP_PASSPHRASE_FILE`。
- `--no-encrypt` 可选，整个归档不加密。

### D6: 部署定位

- 默认从当前目录向上查找 `noj-deploy.json`。
- 支持 `--dir` 显式指定部署目录。

### D7: Judge 统一为组件

- Judge 作为 `deploy` 中的一个组件管理。
- 独立 Worker 场景使用单独一份 `noj-deploy.json`（只启用 judge 组件）。

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| 完全重写工作量大 | 拆分为 P0-P5 六个实现计划，每个计划独立可交付 |
| 从 `.env` 迁移到 JSON 影响现有部署 | 明确不兼容旧脚本，文档同步迁移 |
| 备份格式变化 | 新格式单文件加密归档，便于异地存储 |
| 无升级流程 | 明确列为 Non-Goal，避免范围膨胀 |
