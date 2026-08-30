## MODIFIED Requirements

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
