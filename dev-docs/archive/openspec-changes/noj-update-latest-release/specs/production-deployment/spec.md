## MODIFIED Requirements

### Requirement: 首次安装与升级流程

安装和升级 MUST 复用生产 Compose 中定义的迁移、系统初始化、管理员引导和健康检查机制；安装流程 MUST 在应用服务对外可用前完成一次性初始化，升级流程 MUST 先拉取目标版本镜像并保留已有数据。生产运维入口 MUST 提供显式的最新稳定 Release 查询选项；该选项 MUST 只选择非草稿、非预发布的最新 Release，并在升级前将目标版本展示给运维人员。自动查询失败、没有可用版本或升级前置校验失败时，系统 MUST 返回非零退出码且不得修改生产版本配置。

#### Scenario: 首次安装成功

- **WHEN** 用户已完成生产配置并执行 `install`
- **THEN** 系统拉取目标版本镜像，等待基础设施就绪，完成数据库迁移、系统数据初始化和管理员引导，启动全部服务并执行健康检查

#### Scenario: 初始化失败阻止对外启动

- **WHEN** 数据库迁移、系统初始化、管理员引导或基础设施健康检查失败
- **THEN** 系统返回非零退出码，报告失败服务或阶段，并不得宣称部署成功

#### Scenario: 升级保留数据

- **WHEN** 用户修改 `NOJ_VERSION` 后执行 `upgrade`
- **THEN** 系统拉取新版本并重建服务，复用已有数据卷，执行必要迁移，并在健康检查通过后报告升级完成

#### Scenario: 显式升级到最新稳定 Release

- **WHEN** 运维人员在已有生产安装目录执行 `noj update --latest`
- **THEN** 系统查询仓库最新的非草稿、非预发布 Release，展示目标版本，更新 `NOJ_VERSION`，并复用标准备份、镜像校验、升级和健康检查流程

#### Scenario: 已经是最新稳定 Release

- **WHEN** 运维人员执行 `noj update --latest` 且当前 `NOJ_VERSION` 已经是最新稳定 Release
- **THEN** 系统报告无需升级，返回成功，不修改 `NOJ_VERSION`，不重启服务且不创建升级备份

#### Scenario: 最新版本查询或升级前置检查失败

- **WHEN** GitHub Releases 查询失败、没有非草稿非预发布 Release，或升级前校验失败
- **THEN** 系统返回非零退出码，不修改 `NOJ_VERSION`，不删除数据卷，并提示运维人员使用固定版本重试或查看诊断信息
