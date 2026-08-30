## Purpose

为 Neuro OJ 用户提供可重复、可检查且不会误删持久化数据的生产部署入口，降低首次安装和后续升级的操作复杂度。

## Requirements

### Requirement: 生产配置初始化与安全检查

部署入口 MUST 使用仓库根目录的生产环境模板初始化配置文件，并在执行会启动或变更服务的操作前检查生产必填项、占位值、secret 文件权限和 Docker Compose 配置；检查失败时 MUST 停止后续操作并给出不包含 secret 明文的错误信息。

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

部署入口 MUST 提供 install、start、upgrade、stop、status 和 logs 命令，并默认使用 `docker-compose.prod.yml` 与 `.env.prod`；命令失败时 MUST 返回非零退出码。

#### Scenario: 启动生产服务

- **WHEN** 用户执行 `start`
- **THEN** 系统校验配置后启动生产 Compose 中的服务，并报告 Compose 操作结果

#### Scenario: 安全停止服务

- **WHEN** 用户执行 `stop`
- **THEN** 系统停止生产服务但保留 PostgreSQL、Redis、MinIO、题目包和 judge 缓存数据卷

#### Scenario: 查看服务状态和日志

- **WHEN** 用户执行 `status` 或 `logs [service]`
- **THEN** 系统展示生产 Compose 的服务状态或指定服务日志，并且不输出环境文件中的 secret 值

### Requirement: 首次安装与升级流程

安装和升级 MUST 复用生产 Compose 中定义的迁移、系统初始化、管理员引导和健康检查机制；安装流程 MUST 在应用服务对外可用前完成一次性初始化，升级流程 MUST 先拉取目标版本镜像并保留已有数据。

#### Scenario: 首次安装成功

- **WHEN** 用户已完成生产配置并执行 `install`
- **THEN** 系统拉取目标版本镜像，等待基础设施就绪，完成数据库迁移、系统数据初始化和管理员引导，启动全部服务并执行健康检查

#### Scenario: 初始化失败阻止对外启动

- **WHEN** 数据库迁移、系统初始化、管理员引导或基础设施健康检查失败
- **THEN** 系统返回非零退出码，报告失败服务或阶段，并不得宣称部署成功

#### Scenario: 升级保留数据

- **WHEN** 用户修改 `NOJ_VERSION` 后执行 `upgrade`
- **THEN** 系统拉取新版本并重建服务，复用已有数据卷，执行必要迁移，并在健康检查通过后报告升级完成

#### Scenario: 已有安装同步部署文件

- **WHEN** 用户执行固定版本更新，且当前 NOJ Compose 栈已经监听配置的 Nginx 端口
- **THEN** 文件同步阶段不得因当前 NOJ 自身监听而失败，并必须继续进入升级流程

#### Scenario: 更新同步不执行安装流程

- **WHEN** `noj update` 调用 bootstrap 的 `--files-only` 模式
- **THEN** bootstrap 只同步部署文件和运维命令，不启动服务、不执行目标版本的安装流程，并返回真实同步状态

### Requirement: 可恢复的备份和诊断

部署入口 MUST 提供一个不删除数据的数据库备份操作，并在部署失败时给出可执行的状态、日志和配置检查建议；备份操作 MUST 使用受限文件权限保存产物。

#### Scenario: 创建 PostgreSQL 备份

- **WHEN** 用户执行 `backup`
- **THEN** 系统在指定备份目录创建带时间戳的 PostgreSQL 备份文件，文件默认仅属主可读写，并报告文件路径

#### Scenario: 备份前置条件不满足

- **WHEN** PostgreSQL 服务未运行或备份命令失败
- **THEN** 系统返回非零退出码并提示如何查看服务状态和日志，不删除现有备份

#### Scenario: 首次安装准备备份口令

- **WHEN** 用户首次安装且没有配置 GPG 备份口令文件
- **THEN** 系统在仓库外创建权限为 600 或 400 的随机口令文件，记录非敏感路径并提示用户保存；无法创建时在启动服务前失败

#### Scenario: PostgreSQL 备份结构校验

- **WHEN** 系统创建自定义格式 PostgreSQL 快照
- **THEN** `pg_restore --list` 从标准输入读取 dump，校验成功后才写入快照 `SUCCESS` 标记

### Requirement: 升级后反向代理刷新

升级或启动重建 Core/UI 容器后，部署入口 MUST 重新创建 Nginx 反向代理容器，使其解析新的上游容器地址，并在刷新失败时返回非零退出码。

#### Scenario: 应用容器重建后刷新 Nginx

- **WHEN** Compose 健康检查已通过且 Core 或 UI 容器可能已被重建
- **THEN** 系统重新创建 Nginx 反向代理容器并继续报告入口可用

### Requirement: 外部依赖和生产安全边界

部署入口 MUST 检查 Docker daemon、Docker Compose、必要的 Judge Docker socket 和宿主机端口；MUST 不自动挂载应用宿主机 Docker socket、不删除数据卷、不把密钥写入镜像或日志，并 MUST 对官方镜像、镜像加速器和代理的配置方式提供清晰提示。

#### Scenario: Judge 隔离 Docker socket 缺失

- **WHEN** `JUDGE_DOCKER_SOCKET` 未配置、路径不存在或配置为应用宿主机默认 Docker socket
- **THEN** 系统在启动 Judge Worker 前失败，并提示使用独立隔离的 Docker daemon socket

#### Scenario: Docker 镜像网络失败

- **WHEN** 拉取镜像因网络、代理或镜像源不可达而失败
- **THEN** 系统返回非零退出码，并提示用户检查 Docker daemon 的 registry mirror、代理或镜像版本配置
