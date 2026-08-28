## Why

生产部署模板仍允许使用开发期默认值：`EMAIL_PROVIDER=mock`、`STORAGE_PROVIDER=local`，并且 core 直接复用 MinIO root 凭据作为应用 S3 凭据。部分配置缺失时服务只记录警告继续启动，容易形成“服务健康但关键功能不可用或权限过大”的生产状态。

## What Changes

- 生产环境启动时对邮件、对象存储、密钥、应用地址、CORS 和可信代理配置执行 fail-fast 校验。
- 生产环境禁止 mock 邮件 Provider、local 存储和已知占位符；邮件 Provider 或 S3 凭据缺失时拒绝启动。
- 生产 Compose 改用独立的应用 S3 凭据，不再把 MinIO root 凭据注入 noj-core。
- 由 MinIO 初始化服务创建仅限目标 bucket 的应用用户和策略。
- 增加部署前配置校验、生产环境变量模板和密钥轮换/失效 Runbook。
- 增加配置校验单元测试与生产 Compose 静态验证。

## Capabilities

### New Capabilities

- `production-config-guardrails`: 生产配置的安全校验、最小权限存储凭据和密钥运维约束。

### Modified Capabilities

- `openspec/specs/email-provider/`: 生产环境必须使用已配置且完整的真实邮件 Provider，并在启动期拒绝 mock 或缺失配置。
- `openspec/specs/object-storage/`: 生产环境必须使用配置完整的 S3 Provider，并使用非 root 的应用存储凭据。

## Impact

- 影响 `noj-core` 启动校验、邮件 Provider 与 StorageProvider 初始化。
- 影响 `docker-compose.prod.yml`、`.env.prod.example`、MinIO 初始化策略和运维文档。
- 新增生产配置校验脚本/测试，不改变开发和测试环境的 mock/local 默认行为。
- 现有使用 root S3 凭据的生产部署需要迁移到新的应用凭据。
