## Context

当前根目录 `noj` 负责命令路由，生产 Compose 参数、Docker 检查和生命周期逻辑集中在
`scripts/deploy/deploy.sh`。现有 `stop` 只停止服务并保留数据；卸载需要扩大清理范围，
但不能依赖完整的生产配置校验或镜像签名校验，否则配置损坏时反而无法清理已经部署的栈。

## Goals / Non-Goals

**Goals:**

- 在 `noj` 和底层部署工具中提供一致的 `uninstall` 命令。
- 在交互环境中要求明确确认，在自动化环境中要求显式 `--yes`。
- 删除 Compose 栈容器、网络和 Compose 管理的本地镜像，但始终保留数据卷、配置、备份和部署目录。
- 支持 `--all` 完全清理数据卷和当前安装目录，并拒绝删除 Git 工作区。
- 仅删除指向当前安装目录的 PATH 软链接，避免误删另一套安装。

**Non-Goals:**

- 普通 `uninstall` 不删除 Docker 数据卷、题目包、提交记录、数据库、对象存储、Judge 缓存或备份。
- 普通 `uninstall` 不删除安装目录；完全删除仅由显式 `--all` 触发。
- 不删除外部 Nginx/Caddy/宝塔站点、证书、独立 Judge 主机或非 Compose 容器。
- 不为卸载增加新的数据恢复或跨主机迁移流程。

## Decisions

1. **将卸载作为部署脚本生命周期命令。** 根目录 CLI 继续只做路由，复用统一的 Compose 文件、环境文件和 Docker CLI 选择。这样直接执行 `deploy.sh uninstall` 与 `noj uninstall` 的行为一致。

2. **区分普通卸载和完全删除。** 普通卸载使用 `docker compose down --remove-orphans --rmi local`，禁止 `--volumes`；`--all` 使用 `docker compose down --remove-orphans --rmi all --volumes`，由用户的明确确认开启数据删除。两种模式都始终启用 judge profile，确保此前启用过的 Judge 容器也被纳入清理。

3. **卸载只做轻量运行时检查。** 仅检查 Docker daemon、Compose、环境文件和 Compose 文件存在，不执行生产配置完整性、Judge socket 或 Cosign 检查。卸载必须能处理服务已经停止、配置过期或镜像已不可用的场景。

4. **使用确认词而不是普通 yes/no。** 交互提示要求输入 `UNINSTALL`；非交互运行必须提供 `--yes`。拒绝确认发生在任何 Compose 操作之前，确保取消操作没有副作用。

   `--all` 使用更强的 `DELETE ALL` 确认；`--all --yes` 才能在自动化环境删除数据。

5. **安全清理 PATH 软链接。** 只删除由当前安装目录 `noj` 文件创建、且仍指向该文件的软链接；普通文件和其他安装目录的链接都不删除。

   只有根目录 `noj` 入口在 Compose 清理成功后删除当前安装目录；存在 `.git` 时拒绝执行该步骤。

## Risks / Trade-offs

- [Risk] `--rmi local` 可能删除同一 Compose 项目复用的本地镜像 → 只作用于当前 Compose 项目，且不触碰数据卷；需要再次部署时 Compose 会重新拉取镜像。
- [Risk] 用户以为卸载会删除全部数据 → 帮助和运维文档明确说明数据卷和配置会保留，并提供后续人工数据清理提示但不自动执行。
- [Risk] `--all` 删除生产数据后无法恢复 → 使用独立确认词、非交互强制 `--yes`，并在提示中要求先将备份下载到其他位置。
- [Risk] 配置文件缺失导致 Compose 无法解析 → 在执行前给出明确错误；用户仍可使用保留的 Compose 文件和配置恢复，命令不会尝试删除不确定的资源。

## Migration Plan

无需数据库或数据格式迁移。升级到包含该命令的部署文件后，用户可在安装目录执行
`noj uninstall`；已存在的容器和数据卷不需要迁移。若卸载后恢复服务，重新执行
`noj start` 或 `noj install` 即可重新拉取镜像并复用保留的数据卷。
