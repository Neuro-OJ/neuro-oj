# first-user-admin-registration Specification

## Purpose

让生产环境无需提前填写管理员凭据，用户完成首次注册后即可安全获得平台管理权限，同时避免已有站点或并发注册意外产生额外管理员。

## Requirements

### Requirement: 首个真实注册用户成为管理员

当数据库中只有系统 root 用户而没有任何真实用户时，注册接口 MUST 将第一个成功注册的真实用户分配平台 `admin` 角色，并在注册响应中标明其为管理员。

#### Scenario: 空站点首次注册

- **WHEN** 用户注册成功且数据库中不存在除系统 root 外的用户
- **THEN** 系统 MUST 为该用户分配 `admin` 角色
- **AND** 注册响应 MUST 将 `is_admin` 设置为 `true`

#### Scenario: 已有站点注册新用户

- **WHEN** 数据库中已经存在至少一个除系统 root 外的用户
- **THEN** 新注册用户 MUST 只获得普通用户默认角色
- **AND** 注册响应 MUST 将 `is_admin` 设置为 `false`

#### Scenario: 并发首次注册

- **WHEN** 多个用户同时在空站点注册
- **THEN** 至多一个注册用户 MUST 获得 `admin` 角色
- **AND** 其他成功注册用户 MUST 保持普通用户权限

### Requirement: 管理员环境变量不再是生产安装必填项

生产部署 MUST 不要求用户在安装前填写管理员邮箱或管理员密码；生产初始化 MUST 不因缺少 `ADMIN_EMAIL` 或 `ADMIN_PASS` 而失败。

#### Scenario: 不填写管理员信息完成安装

- **WHEN** 用户只填写网站、版本、存储、邮件和 Judge 连接等部署配置
- **THEN** 生产配置校验 MUST 通过管理员字段检查
- **AND** 初始化流程 MUST 不自动创建随机管理员账号
- **AND** 系统 MUST 提示用户打开网站后注册首个用户

#### Scenario: 已有站点升级

- **WHEN** 已有真实用户的站点执行升级或重新部署
- **THEN** 系统 MUST 保留现有管理员和用户角色
- **AND** 后续注册用户 MUST NOT 因为安装流程变化而自动获得管理员权限
