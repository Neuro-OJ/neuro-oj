# Agent Note: 恢复独立的一键部署入口

Status: implemented

## Problem

将 `noj-cli` 作为 GitHub Release 二进制和唯一生产入口后，安装依赖缺失的 Release 资产，
并且旧版用户熟悉的 `setup.sh`、`noj`、生产配置和 Judge 部署流程被移除。新旧配置模型和服务命名
同时存在时，用户无法直接判断应该使用哪套部署方式。

## Decision

恢复 `setup.sh`、根目录 `noj`、`scripts/deploy/` 生产脚本、独立 Judge 安装脚本和 `.env.prod`
配置流程。生产 Compose 恢复 `core` 服务名，同时兼容当前已发布的 `noj-server` 镜像，`noj` 负责安装、升级、备份、诊断和
卸载。保留 `noj-cli/` 源码目录供独立开发和测试，但从 Release workflow 移除 CLI/Server 二进制
构建与上传任务；Release 只发布生产 Docker 镜像。

## Alternatives considered

- 继续让 `noj-cli` 作为唯一入口：安装路径短，但依赖二进制 Release 资产，旧配置和已有部署无法平滑复用。
- 完全删除 `noj-cli`：能减少维护面，但会丢失已有 CLI 实验代码和后续可复用的部署编排实现。
- 同时维护两套生产入口：短期有少量文档和测试维护成本，但能兼容已有用户并降低迁移风险，因此采用该方案，
  并明确 `noj` 是生产入口、`noj-cli` 是源码工具。

## Consequences

- 空服务器可以继续使用一条 `curl ... setup.sh | bash` 命令完成部署，不依赖 CLI Release 资产。
- 旧版 `.env.prod`、数据卷、备份和 Judge 配置可以继续使用；升级和回滚命令保持稳定。
- `noj-cli` 的二进制安装方式不再有效，CLI 使用者需要从源码目录通过 Deno 运行。
- Release workflow 的镜像命名与生产 Compose 保持一致，发布验证不再依赖 `noj-cli` 或 `noj-server` Release 资产。
