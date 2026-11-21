## Why

当前生产运维需要直接调用较长的 `scripts/deploy/deploy.sh` 路径，并且版本更新使用 `upgrade` 命令，首次使用者不容易记忆。统一的 `noj` 命令可以降低启动、停止、更新和日常管理的操作成本，同时复用现有部署脚本已经实现的配置校验、备份、镜像签名验证和健康检查。

## What Changes

- 新增仓库根目录的 `noj` 命令入口，支持生产服务的常用生命周期操作。
- 提供 `install`、`start`、`stop`、`restart`、`update`、`status`、`logs`、`backup`、`verify` 和 `config` 管理命令。
- `update` 使用现有生产升级流程，继续执行升级前备份、镜像校验、数据库迁移和健康检查，并保留现有 `deploy.sh upgrade` 兼容入口。
- `setup.sh` 是唯一推荐的首次安装入口；安装完成后，`noj update` 负责同步目标 Release 的部署文件、CLI 和生产镜像，再执行安全升级。
- 命令自动定位仓库根目录，默认使用 `.env.prod` 和 `docker-compose.prod.yml`，支持将部署脚本已有的相关选项继续传递下去。
- 安装成功后将 `noj` 注册到标准 PATH 目录；若无权限，则安装到用户级 `~/.local/bin` 并在登录配置中补充 PATH，拒绝覆盖已有同名命令。
- 更新部署文档、命令帮助和脚本测试，明确失败时的退出码与不会删除数据卷的安全边界。

## Capabilities

### New Capabilities

- `production-cli`: 提供统一的 `noj` 生产运维命令及其生命周期、诊断和配置管理子命令。

### Modified Capabilities

- `openspec/specs/production-deployment`: 将 `noj` 作为生产部署入口，并补充 `update`、`restart` 和配置检查命令的行为要求，同时保留现有脚本兼容性。

## Impact

- 新增根目录可执行脚本及其参数解析、路径定位和命令转发逻辑。
- 复用并可能小幅调整 `scripts/deploy/deploy.sh` 的命令接口，不引入新的运行时依赖。
- 更新 `README.md`、生产部署文档和脚本测试。
- 不修改数据库 Schema，不改变 Compose 服务、数据卷或现有部署安全边界。
