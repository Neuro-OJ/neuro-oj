## MODIFIED Requirements

### Requirement: 生产生命周期命令

部署入口 MUST 提供 install、start、upgrade、stop、status、logs 和 uninstall 命令，并默认使用 `docker-compose.prod.yml` 与 `.env.prod`；命令失败时 MUST 返回非零退出码。普通 `uninstall` MUST 在执行前获得明确确认，删除当前生产 Compose 栈的容器和网络，并清理 Compose 管理的本地镜像；除非用户使用 `--all`，卸载 MUST 保留 PostgreSQL、Redis、MinIO、题目包和 Judge 缓存数据卷、`.env.prod`、备份和部署目录。`uninstall --all` MUST 在单独的完全删除确认下删除当前栈的容器、网络、镜像和数据卷，并删除当前 NOJ 安装目录；检测到 Git 工作区时 MUST 拒绝删除安装目录。

#### Scenario: 启动生产服务

- **WHEN** 用户执行 `start`
- **THEN** 系统校验配置后启动生产 Compose 中的服务，并报告 Compose 操作结果

#### Scenario: 安全停止服务

- **WHEN** 用户执行 `stop`
- **THEN** 系统停止生产服务但保留 PostgreSQL、Redis、MinIO、题目包和 judge 缓存数据卷

#### Scenario: 查看服务状态和日志

- **WHEN** 用户执行 `status` 或 `logs [service]`
- **THEN** 系统展示生产 Compose 的服务状态或指定服务日志，并且不输出环境文件中的 secret 值

#### Scenario: 交互式卸载生产栈

- **WHEN** 用户在可交互终端执行 `uninstall` 并输入明确确认词
- **THEN** 系统停止并删除当前生产 Compose 栈的容器和网络，清理 Compose 管理的本地镜像，移除指向当前安装目录的 PATH 软链接，并保留数据卷、配置、备份和部署目录

#### Scenario: 未确认的卸载被拒绝

- **WHEN** 用户执行 `uninstall` 但未输入明确确认词，或在非交互环境中未提供 `--yes`
- **THEN** 系统不改变容器、网络、镜像、数据卷或文件，并返回非零退出码

#### Scenario: 显式非交互卸载

- **WHEN** 用户在自动化环境执行 `uninstall --yes`
- **THEN** 系统跳过交互提示并执行与已确认交互式卸载相同的清理操作

#### Scenario: 交互式完全删除

- **WHEN** 用户执行 `uninstall --all` 并输入 `DELETE ALL`
- **THEN** 系统删除当前 Compose 栈的容器、网络、镜像和数据卷，移除当前安装目录及其 PATH 软链接

#### Scenario: 完全删除缺少确认或检测到源码工作区

- **WHEN** 用户执行 `uninstall --all` 但未输入 `DELETE ALL`、未提供 `--yes`，或当前目录包含 Git 工作区
- **THEN** 系统返回非零退出码，不删除数据卷、安装目录或文件
