## Purpose

为 Neuro OJ 用户提供可重复、可检查且不会误删持久化数据的生产部署入口，降低首次安装和后续升级的操作复杂度。

## Requirements

### Requirement: 生产配置初始化与安全检查

部署入口 MUST 在下载源码、创建或覆盖安装目录、写入生产配置或启动服务之前，先展示生产部署的最低环境要求和当前主机检测结果。检测结果 MUST 覆盖 Linux 操作系统、CPU 架构、CPU 核数、内存、Swap、目标目录所在磁盘可用空间、Docker Engine、Docker Compose v2、必要基础工具和目标端口；检查失败时 MUST 停止后续操作并给出不包含 secret 明文的错误信息。部署入口 MUST 使用仓库根目录的生产环境模板初始化配置文件，并在执行会启动或变更服务的操作前检查生产必填项、占位值、secret 文件权限和 Docker Compose 配置。

#### Scenario: 安装前展示要求和已有环境

- **WHEN** 用户执行生产 `install`
- **THEN** 系统在获取 Release、下载源码或写入目标目录前，先展示最低要求和当前主机对应检测值，并继续执行阻断性环境检查

#### Scenario: 安装环境检查失败

- **WHEN** Linux、架构、基础工具、Docker/Compose、磁盘或端口检查失败
- **THEN** 系统返回非零退出码，不获取 Release、不下载源码、不覆盖目标目录，并给出修复提示

#### Scenario: 首次安装创建配置模板

- **WHEN** 用户执行安装命令且 `.env.prod` 不存在
- **THEN** 系统创建权限受限的 `.env.prod`，保留需要用户填写的域名、版本、邮件和存储配置，并提示用户完成配置后重新执行安装

#### Scenario: 已有配置不被覆盖

- **WHEN** 用户执行安装命令且 `.env.prod` 已存在
- **THEN** 系统 MUST 保留已有配置，不得静默覆盖或在输出中打印其中的 secret 值

#### Scenario: 生产配置校验失败

- **WHEN** 必填项缺失、仍使用占位值、secret 文件权限过宽、Docker/Compose 不可用或生产 Compose 配置无效
- **THEN** 系统返回非零退出码，并指出配置键或检查项以及修复建议

### Requirement: 生产生命周期命令

部署入口 MUST 提供 install、start、upgrade、stop、status、logs、restart、update、backup、verify、config check 和 uninstall 命令，并默认使用 `docker-compose.prod.yml` 与 `.env.prod`；命令失败时 MUST 返回非零退出码。其中 `update` 是 `upgrade` 的用户友好别名。仓库根目录的 `noj` 命令 SHALL 作为这些生产操作的统一入口，同时保留 `scripts/deploy/deploy.sh` 的兼容调用方式。

普通 `uninstall` MUST 在执行前获得明确确认，删除当前生产 Compose 栈的容器和网络，并清理 Compose 管理的本地镜像；除非用户使用 `--all`，卸载 MUST 保留 PostgreSQL、Redis、MinIO、题目包和 Judge 缓存数据卷、`.env.prod`、备份和部署目录。`uninstall --all` MUST 在单独的完全删除确认下删除当前栈的容器、网络、镜像和数据卷，并删除当前 NOJ 安装目录；检测到 Git 工作区时 MUST 拒绝删除安装目录。

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

### Requirement: 首次安装与升级流程

安装和升级 MUST 复用生产 Compose 中定义的迁移、系统初始化、管理员引导和健康检查机制；安装流程 MUST 在应用服务对外可用前完成一次性初始化，升级流程 MUST 先拉取目标版本镜像并保留已有数据。生产安装不再要求预先配置管理员凭据，安装完成后由第一个真实注册用户获得管理员权限。生产安装支持远程短命令入口，未指定版本时使用最新可用 Release，指定版本时必须使用指定 Release。生产安装 MUST 根据用户的 Judge 选择启用或跳过 Judge 服务；未填写该选择的已有配置 MUST 按启用处理。生产运维入口 MUST 提供显式的最新稳定 Release 查询选项；该选项 MUST 只选择非草稿、非预发布的最新 Release，并在升级前将目标版本展示给运维人员。自动查询失败、没有可用版本或升级前置校验失败时，系统 MUST 返回非零退出码且不得修改生产版本配置。

#### Scenario: 首次安装成功

- **WHEN** 用户已完成生产配置并执行 `install`
- **THEN** 系统拉取目标版本镜像，等待基础设施就绪，完成数据库迁移、系统数据初始化和管理员引导，启动全部已选择的服务并执行健康检查
- **AND** 系统提示用户打开网站注册首个用户，该用户将获得管理员权限

#### Scenario: 初始化失败阻止对外启动

- **WHEN** 数据库迁移、系统初始化、管理员引导、必要的 Judge 配置检查或基础设施健康检查失败
- **THEN** 系统返回非零退出码，报告失败服务或阶段，并不得宣称部署成功

#### Scenario: 升级保留数据

- **WHEN** 用户修改 `NOJ_VERSION` 后执行 `upgrade`
- **THEN** 系统拉取新版本并重建已启用的服务，复用已有数据卷，执行必要迁移，并在健康检查通过后报告升级完成
- **AND** 系统 MUST 保留已有用户和管理员角色

#### Scenario: 远程入口自动选择最新 Release

- **WHEN** 用户通过远程 `setup.sh` 入口开始安装且未指定版本
- **THEN** 系统自动选择最新可用 Release，完成环境检查、配置向导、数据库迁移、系统初始化、服务启动和健康检查

#### Scenario: 显式版本首次安装

- **WHEN** 用户通过远程入口或本地 bootstrap 指定 Release tag
- **THEN** 系统 MUST 使用该版本完成源码下载和生产部署
- **AND** 系统 MUST 不被自动最新版本覆盖

#### Scenario: 显式升级到最新稳定 Release

- **WHEN** 运维人员在已有生产安装目录执行 `noj update --latest`
- **THEN** 系统查询仓库最新的非草稿、非预发布 Release，展示目标版本，更新 `NOJ_VERSION`，并复用标准备份、镜像校验、升级和健康检查流程

#### Scenario: 已经是最新稳定 Release

- **WHEN** 运维人员执行 `noj update --latest` 且当前 `NOJ_VERSION` 已经是最新稳定 Release
- **THEN** 系统报告无需升级，返回成功，不修改 `NOJ_VERSION`，不重启服务且不创建升级备份

#### Scenario: 最新版本查询或升级前置检查失败

- **WHEN** GitHub Releases 查询失败、没有非草稿非预发布 Release，或升级前校验失败
- **THEN** 系统返回非零退出码，不修改 `NOJ_VERSION`，不删除数据卷，并提示运维人员使用固定版本重试或查看诊断信息

#### Scenario: 跳过安装 Judge

- **WHEN** 用户在配置向导中选择不安装 Judge
- **THEN** 系统 MUST 保存 Judge 关闭状态，不要求 Judge Docker socket 存在，启动 core、ui 和基础设施，不启动 Judge Worker，并提示当前部署暂不提供代码评测

#### Scenario: 后续启用 Judge

- **WHEN** 用户补充专用 rootless Docker socket 配置并启用 Judge 后执行启动操作
- **THEN** 系统 MUST 校验 socket 隔离和权限，并启动 Judge Worker

### Requirement: 可恢复的备份和诊断

部署入口 MUST 提供一个不删除数据的数据库备份操作，并在部署失败时给出可执行的状态、日志和配置检查建议；备份操作 MUST 使用受限文件权限保存产物。

#### Scenario: 创建 PostgreSQL 备份

- **WHEN** 用户执行 `backup`
- **THEN** 系统在指定备份目录创建带时间戳的 PostgreSQL 备份文件，文件默认仅属主可读写，并报告文件路径

#### Scenario: 备份前置条件不满足

- **WHEN** PostgreSQL 服务未运行或备份命令失败
- **THEN** 系统返回非零退出码并提示如何查看服务状态和日志，不删除现有备份

### Requirement: 外部依赖和生产安全边界

部署入口 MUST 检查 Docker daemon、Docker Compose、必要的 Judge Docker socket 和宿主机端口；MUST 不自动挂载应用宿主机 Docker socket、不删除数据卷、不把密钥写入镜像或日志，并 MUST 对官方镜像、镜像加速器和代理的配置方式提供清晰提示。

#### Scenario: Judge 隔离 Docker socket 缺失

- **WHEN** `JUDGE_DOCKER_SOCKET` 未配置、路径不存在或配置为应用宿主机默认 Docker socket
- **THEN** 系统在启动 Judge Worker 前失败，并提示使用独立隔离的 Docker daemon socket

#### Scenario: Docker 镜像网络失败

- **WHEN** 拉取镜像因网络、代理或镜像源不可达而失败
- **THEN** 系统返回非零退出码，并提示用户检查 Docker daemon 的 registry mirror、代理或镜像版本配置
