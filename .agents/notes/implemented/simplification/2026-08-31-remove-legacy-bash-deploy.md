# Agent Note: 移除废弃 bash 部署脚本，统一 noj-cli 入口

Status: implemented

## Problem

仓库同时存在多套部署/运维入口：`scripts/deploy/*.sh`、`scripts/dev/devtool.sh`
与根目录 `noj` 脚本。`noj-cli` 已覆盖 doctor、deploy、maintain、run-server 等
能力，旧脚本继续保留会造成入口分散、文档漂移和维护成本上升。

## Decision

- 删除以下废弃入口：
  - `setup.sh`（薄引导）
  - `scripts/deploy/deploy.sh`、`install.sh`、`backup.sh`、`judge-install.sh`
  - `scripts/deploy/test-*.sh`（旧脚本回归测试）
  - `scripts/dev/devtool.sh`、`scripts/dev/README.md`、`scripts/dev/env.example`、
    `scripts/dev/logs/`
  - 根目录 `noj` 旧命令脚本
- 保留 `scripts/deploy/verify-build-server.ts` / `verify-compose-server.ts` 作为
  构建与 Compose 改名门禁；`verify-setup-thin.ts` 随 `setup.sh` 一并移除。
- 同步更新 AGENTS.md、scripts/README.md、dev-docs/engineering、noj-docs 运营文档，
  将命令示例改为 `noj-cli`。

## Alternatives considered

- 继续保留旧脚本作为兼容入口：会维持双入口，违背“仅保留 noj-cli 一个入口”的目标。
- 只删除生产脚本、保留 devtool.sh：开发入口仍分散，且 devtool 依赖的
  `scripts/dev/env.example` 与 JSON 配置模型冲突。

## Consequences

- 部署/运维入口收敛为单一 `noj-cli`：直接下载 GitHub Release 二进制后即可安装、部署与运维。
- 旧文档中指向已删除脚本的链接已更新；历史审计/OpenSpec 归档中的引用保留作为记录。
- 独立 Judge Worker 部署改为通过 `noj-cli` 的独立部署配置管理。
- 升级/卸载等能力目前由 `noj-cli` 的 `deploy up` / `maintain reset` 覆盖，
  旧 `noj update` 等命令不再提供。
