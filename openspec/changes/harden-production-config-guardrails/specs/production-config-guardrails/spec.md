## Purpose

为生产部署提供一致的配置安全边界，在服务对外提供 HTTP 之前拒绝不安全、缺失或仍为模板占位符的关键配置，并让对象存储使用最小权限凭据。

## ADDED Requirements

### Requirement: 生产配置必须在启动期 fail-fast

当 `NOJ_ENV=production` 时，系统 MUST 在启动 HTTP 服务前校验关键配置；任何校验失败 MUST 以非零状态退出，不得仅记录警告后继续运行。校验错误可以包含配置键名和修复提示，但 MUST NOT 输出凭据值。

#### Scenario: 生产环境使用 mock 邮件 Provider

- **WHEN** `NOJ_ENV=production` 且有效邮件 Provider 为 `mock`、缺失或不受支持
- **THEN** 服务在启动 HTTP 监听前退出，并提示必须配置 `aliyun` 或 `tencent`

#### Scenario: 生产环境邮件 Provider 凭据不完整

- **WHEN** 选择的真实邮件 Provider 缺少任一必填配置
- **THEN** 服务在启动 HTTP 监听前退出，并只报告缺失配置键名

#### Scenario: 生产环境使用 local 存储或 S3 配置不完整

- **WHEN** `NOJ_ENV=production` 且存储 Provider 不是 `s3`，或 S3 endpoint、访问密钥、秘密密钥、bucket 任一缺失
- **THEN** 服务在启动 HTTP 监听前退出，并不初始化 local 存储

#### Scenario: 生产环境存在占位符或不安全外部地址

- **WHEN** JWT/TFA/数据库/Redis/管理员等关键凭据仍为已知模板占位符，或 `APP_URL`、CORS 来源不是 HTTPS，或可信代理为空
- **THEN** 服务在启动 HTTP 监听前退出，且日志不包含占位符的完整值

### Requirement: 生产部署必须使用最小权限的对象存储凭据

生产 Compose MUST 将 MinIO root 凭据限制在初始化服务使用；noj-core MUST 使用独立的应用 S3 凭据。应用凭据 MUST 仅拥有目标支持包 bucket 所需的列举、读、写和删除权限，不得拥有 MinIO 管理权限或其他 bucket 的权限。

#### Scenario: 初始化生产 MinIO bucket

- **WHEN** 生产部署首次启动或重复执行初始化服务
- **THEN** 目标 bucket 被幂等创建，并创建/更新仅作用于该 bucket 的应用策略和应用用户

#### Scenario: core 使用应用 S3 凭据

- **WHEN** 生产 core 服务启动
- **THEN** core 的 `S3_ACCESS_KEY`/`S3_SECRET_KEY` 与 MinIO root 凭据分离，且 root 凭据不注入 core 环境

### Requirement: 生产密钥轮换必须可执行且可验证

生产运维文档 MUST 为 JWT、TFA、数据库、Redis、S3、邮件凭据定义轮换顺序、重启/切换步骤、旧凭据失效步骤和回滚注意事项；轮换步骤 MUST 明确哪些密钥会使既有会话或已加密数据失效。

#### Scenario: 轮换 S3 应用凭据

- **WHEN** 运维人员按 Runbook 创建新应用凭据并更新生产 secret
- **THEN** 新凭据可完成支持包读写，旧凭据被撤销，且 core 重启后不再使用旧凭据

#### Scenario: 轮换 JWT 或 TFA 密钥

- **WHEN** 运维人员按 Runbook 轮换 JWT 或 TFA 密钥
- **THEN** Runbook 明确 JWT 既有会话失效或 TFA 数据迁移/恢复影响，且部署前要求完成备份与回滚确认
