## Purpose

为生产部署提供一个统一、可发现且安全的 `noj` 命令入口，让运营者可以用一致的命令完成服务生命周期、版本更新、状态诊断、日志查看、备份和配置检查。

## ADDED Requirements

### Requirement: 统一生产命令入口

系统 SHALL 在生产安装目录提供可执行的 `noj` 命令入口，并默认使用该目录下的 `.env.prod` 与 `docker-compose.prod.yml`。命令 SHALL 从任意当前工作目录解析自身所在的安装目录，不得依赖调用者当前目录。

#### Scenario: 显示帮助

- **WHEN** 用户执行 `noj help` 或 `noj --help`
- **THEN** 系统展示所有支持的子命令、常用参数和默认配置文件位置，并返回退出码 0

#### Scenario: 从其他目录执行

- **WHEN** 用户在生产安装目录之外执行 `/opt/neuro-oj/noj status`
- **THEN** 系统仍使用 `/opt/neuro-oj/.env.prod` 和 `/opt/neuro-oj/docker-compose.prod.yml` 执行状态查询

### Requirement: 安装后加入 PATH

生产安装成功后，系统 SHALL 注册一个指向当前安装目录 `noj` 文件的命令链接，使用户
可以直接执行 `noj <命令>`。系统 SHALL 优先使用 `/usr/local/bin/noj`；当前用户无权限时
可以使用 `~/.local/bin/noj` 并在用户登录 PATH 配置中补充该目录。系统 SHALL 拒绝覆盖
已有非本项目同名命令或链接。

#### Scenario: 注册全局命令

- **WHEN** 用户以有权限的方式完成生产安装
- **THEN** `/usr/local/bin/noj` 指向该安装目录中的 `noj`，且通过该路径执行时仍能定位原安装目录

#### Scenario: 无全局目录权限

- **WHEN** 用户无法写入 `/usr/local/bin`
- **THEN** 系统尝试创建 `~/.local/bin/noj` 并补充登录 PATH；若用户级目录也不可用，安装仍保留已完成的部署并给出手动处理提示

#### Scenario: 不覆盖同名命令

- **WHEN** PATH 目标位置已经存在非当前安装的文件或链接
- **THEN** 系统不覆盖该目标，给出警告，并保留当前安装结果

### Requirement: 生命周期与更新命令

`noj` SHALL 提供 `install`、`start`、`stop`、`restart` 和 `update` 子命令。`update` SHALL 使用与现有生产升级入口相同的安全流程，包括升级前备份、镜像校验、必要迁移和健康检查；`stop` 和 `restart` SHALL 保留持久化数据卷。

#### Scenario: 启动和停止服务

- **WHEN** 用户执行 `noj start` 或 `noj stop`
- **THEN** 系统分别启动或停止生产 Compose 服务，校验失败或 Compose 失败时返回非零退出码，并且 `stop` 不删除数据卷

#### Scenario: 重启服务

- **WHEN** 用户执行 `noj restart`
- **THEN** 系统安全停止并重新启动生产服务，复用现有配置和数据卷，并在启动健康检查失败时返回非零退出码

#### Scenario: 更新生产版本

- **WHEN** 用户修改 `.env.prod` 中的 `NOJ_VERSION` 后执行 `noj update`
- **THEN** 系统先按 `NOJ_VERSION` 同步部署文件和 `noj` 命令，再创建并校验备份，校验目标镜像，拉取目标版本，执行必要迁移并等待健康检查；任一阶段失败时返回非零退出码且不得宣称升级成功

### Requirement: 唯一首次安装入口

新用户 SHALL 使用仓库根目录的 `setup.sh` 完成首次安装；安装完成后，日常启停、升级和管理
SHALL 使用安装目录中的 `noj`。`scripts/deploy/install.sh` 可以保留为 setup.sh 的内部
bootstrap 和旧版本兼容入口，但不得作为新安装文档的推荐入口。

#### Scenario: setup 委托 noj 初始化

- **WHEN** 用户通过 `setup.sh` 完成源码下载
- **THEN** bootstrap 将生产初始化和首次服务部署委托给目标目录的 `noj install`，并在成功后注册 PATH 命令

#### Scenario: noj update 同步部署文件

- **WHEN** 用户执行 `noj update`
- **THEN** 系统按 `.env.prod` 的 `NOJ_VERSION` 更新部署脚本和 `noj` 文件，再执行原有带备份的 `deploy.sh upgrade` 流程

### Requirement: 运维管理与诊断

`noj` SHALL 提供 `status`、`logs`、`backup`、`verify` 和 `config check` 管理命令。管理命令 SHALL 复用现有部署安全检查，不得输出 `.env.prod` 中的 secret 明文。

#### Scenario: 查看状态与日志

- **WHEN** 用户执行 `noj status` 或 `noj logs [service] [--follow]`
- **THEN** 系统展示生产 Compose 的服务状态或指定服务日志，并返回底层命令的退出码

#### Scenario: 创建备份与校验镜像

- **WHEN** 用户执行 `noj backup` 或 `noj verify`
- **THEN** 系统分别创建受限权限的生产备份或校验已配置版本的生产镜像，并在失败时返回非零退出码

#### Scenario: 检查配置

- **WHEN** 用户执行 `noj config check`
- **THEN** 系统检查生产配置、secret 文件权限、Compose 配置、Judge 隔离 Docker socket 和必要外部依赖，但不启动、停止、更新服务，也不修改生产配置

### Requirement: 兼容与安全边界

新命令 SHALL 复用既有 `scripts/deploy/deploy.sh` 的行为，保留 `deploy.sh upgrade` 等旧入口可用；新命令不得执行 `down -v`、删除生产数据卷、自动挂载应用宿主机 Docker socket 或在输出中泄露 secret。

#### Scenario: 底层命令失败传播

- **WHEN** 被转发的生产操作失败
- **THEN** `noj` 返回非零退出码，并保留底层脚本的可执行错误信息
