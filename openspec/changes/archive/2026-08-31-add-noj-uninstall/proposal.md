## Why

生产实例目前可以通过 `noj stop` 停止服务，但没有统一的卸载入口。用户需要手动拼接
Docker Compose 清理命令，容易遗漏容器、网络或 PATH 中的命令，也容易误用 `down -v`
误删题目、提交记录和数据库。现在补充安全的 `noj uninstall`，让卸载动作可复用且边界明确。

## What Changes

- 新增 `noj uninstall`，停止并删除当前生产 Compose 栈的容器和网络，清理 Compose 管理的本地镜像。
- 卸载前要求交互确认；自动化场景必须显式传入 `--yes`，避免误触发破坏性操作。
- 卸载默认不删除 PostgreSQL、Redis、MinIO、题目包和 Judge 缓存数据卷，不删除 `.env.prod`、备份或部署目录。
- 新增 `noj uninstall --all`，在单独的 `DELETE ALL` 确认或 `--yes` 下删除全部 Compose 数据卷，并删除当前 NOJ 安装目录；检测到 Git 工作区时拒绝执行。
- 成功后只移除指向当前安装目录的 PATH 软链接，不覆盖或删除其他安装的 `noj` 命令。
- 更新 CLI 帮助、生产部署文档、README 和无 Docker 测试。

## Capabilities

### New Capabilities

无。卸载是现有生产部署生命周期能力的扩展。

### Modified Capabilities

- `production-deployment`: 生产部署入口增加带确认、保留数据卷的 `uninstall` 生命周期命令。

## Impact

- 影响根目录 `noj` CLI 和 `scripts/deploy/deploy.sh` 的命令路由、Compose 清理逻辑及 PATH 注册清理。
- 生产部署规范和运维文档需要说明卸载的资源范围与数据保留边界。
- 不新增运行时依赖；继续使用现有 Docker Compose 和 Bash 测试设施。
