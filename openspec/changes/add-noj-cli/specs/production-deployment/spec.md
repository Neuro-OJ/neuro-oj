## MODIFIED Requirements

### Requirement: 生产生命周期命令

部署入口 MUST 提供 `install`、`start`、`upgrade`、`stop`、`status`、`logs`、`restart`、`update`、`backup`、`verify` 和 `config check` 命令，并默认使用 `docker-compose.prod.yml` 与 `.env.prod`。其中 `update` 是 `upgrade` 的用户友好别名；命令失败时 MUST 返回非零退出码。仓库根目录的 `noj` 命令 SHALL 作为这些生产操作的统一入口，同时保留 `scripts/deploy/deploy.sh` 的兼容调用方式。

#### Scenario: 启动生产服务

- **WHEN** 用户执行 `start` 或 `noj start`
- **THEN** 系统校验配置后启动生产 Compose 中的服务，并报告 Compose 操作结果

#### Scenario: 安全停止服务

- **WHEN** 用户执行 `stop` 或 `noj stop`
- **THEN** 系统停止生产服务但保留 PostgreSQL、Redis、MinIO、题目包和 judge 缓存数据卷

#### Scenario: 重启生产服务

- **WHEN** 用户执行 `noj restart`
- **THEN** 系统安全停止并重新启动生产服务，复用已有配置和数据卷，并在健康检查失败时返回非零退出码

#### Scenario: 查看服务状态和日志

- **WHEN** 用户执行 `status`、`logs [service]`、`noj status` 或 `noj logs [service]`
- **THEN** 系统展示生产 Compose 的服务状态或指定服务日志，并且不输出环境文件中的 secret 值

#### Scenario: 更新生产版本

- **WHEN** 用户修改 `NOJ_VERSION` 后执行 `upgrade` 或 `noj update`
- **THEN** 系统先完成生产备份和镜像校验，再拉取目标版本、执行必要迁移并等待健康检查通过后报告升级完成

#### Scenario: 检查生产配置

- **WHEN** 用户执行 `noj config check`
- **THEN** 系统检查生产必填项、secret 文件权限、Compose 配置、必要的 Judge Docker socket 和外部依赖，但不启动、停止或更新服务
