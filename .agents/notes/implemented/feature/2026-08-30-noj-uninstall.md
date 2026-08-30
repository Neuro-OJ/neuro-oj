# Agent Note: noj 一键卸载

Status: implemented

## Problem

生产部署只有停止、升级和状态管理入口，没有统一卸载能力。手动执行 Compose 清理命令容易遗漏资源，也可能误用 `down -v` 删除生产数据卷。

## Decision

新增 `noj uninstall` 及底层 `deploy.sh uninstall`：

- 默认要求在终端输入 `UNINSTALL`；自动化环境必须显式传入 `--yes`。
- 使用 Compose 清理当前项目的容器、网络和本地镜像，始终保留数据卷。
- 保留 `.env.prod`、备份和部署目录，且不修改宿主机反向代理、证书或其他容器。
- `uninstall --all` 使用独立的 `DELETE ALL` 确认，删除 Compose 数据卷和当前安装目录；检测到 Git 工作区时拒绝删除。
- 卸载成功后只移除指向当前安装目录的 PATH 软链接；dry-run 或失败时不移除。

## Alternatives considered

- 使用 `docker compose down -v`：清理更彻底，但会删除数据库、对象存储、题目包和 Judge 缓存，风险不可接受。
- 默认不提供完全删除：保留数据更适合误操作恢复；现在通过显式 `--all` 提供完全删除能力。
- 不提供卸载命令：可以避免自动清理误操作，但用户需要手动处理多个 Compose 资源，容易残留或执行错误项目。
- 删除所有同名 `noj` 命令：可能破坏其他安装，因此只删除明确指向当前安装目录的软链接。

## Consequences

- 用户可以通过一个明确确认的命令释放生产容器、网络和本地镜像资源，并保留数据以便恢复。
- 卸载后重新执行 `noj start` 会复用保留的数据卷并重新拉取镜像。
- `uninstall --all` 后当前安装目录和数据已删除，只有外部备份可用于恢复。
- 如需永久删除数据，仍需用户在确认备份后单独执行数据清理操作。
