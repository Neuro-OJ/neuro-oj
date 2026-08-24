## Context

当前 `noj-core` 在数据库设置初始化后检查邮件和存储配置，但缺失配置只产生 warning；生产 Compose 将 `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` 同时作为 core 的 S3 凭据。项目已经有启动期 JWT、TFA 和可信代理检查，可在同一启动阶段扩展为统一的生产配置校验。

## Goals / Non-Goals

**Goals:**

- 在 HTTP 服务启动前拒绝生产环境的关键配置错误和模板占位符。
- 保持开发、测试环境继续使用 mock 邮件和 local 存储。
- 让生产 MinIO 初始化服务创建 bucket-scoped 应用用户，并从 core 环境中移除 root 凭据。
- 提供不泄露密钥的配置检查输出和轮换 Runbook。

**Non-Goals:**

- 本变更不引入具体的云 secrets manager SDK；通过受限 secret 文件、Compose 注入或外部 secrets manager 提供环境变量。
- 本变更不实现在线双密钥同时使用；JWT/TFA/数据库/Redis/邮件密钥的切换窗口和影响在 Runbook 中明确。
- 本变更不改变 S3StorageProvider 的 URL 协议和业务 API。

## Decisions

### 1. 统一纯函数校验，再由 main.ts 执行 fail-fast

新增可独立测试的生产配置校验模块，输入环境变量和已解析的系统设置，返回不包含秘密值的 finding 列表。`main.ts` 在 `initSystemSettings()` 后调用该模块，并通过现有 `fatalStep` 终止启动。这样既复用 DB-backed 设置的最终值，又避免在单元测试中启动完整服务。

备选方案是只修改各 Provider 的首次调用行为；该方案会让服务先变成“健康”状态，直到用户触发密码重置或题目包操作才失败，不满足 fail-fast 目标。

### 2. 生产只允许 S3 和真实邮件 Provider

生产校验读取 `getSetting()` 的最终值，要求邮件 Provider 为 `aliyun`/`tencent`，并检查其必填项；存储 Provider 必须为 `s3`，检查 endpoint、access key、secret key 和 bucket。开发/测试不启用这些限制。

### 3. MinIO root 与应用身份分离

生产 Compose 新增 `S3_ACCESS_KEY`/`S3_SECRET_KEY`，core 只接收这两项；`minio-init` 继续使用 root 凭据创建 bucket、策略和应用用户。策略文件只授予目标 bucket 的 `ListBucket`、`GetObject`、`PutObject`、`DeleteObject` 和 `GetBucketLocation` 权限，并通过挂载只读 JSON 文件供 `mc` 使用。

备选方案是继续使用 MinIO 内置 `readwrite` 策略；该策略范围过大，可能访问其他 bucket，不符合 Issue #330 的最小权限要求。

### 4. 配置检查不打印凭据

配置校验只记录配置键名、失败原因和修复提示；不打印实际值、连接串、API key 或 password。模板检查沿用已有 `check-env.ts` 的占位符思想，但生产启动校验使用键级规则，避免把密码值写入日志。

## Risks / Trade-offs

- [Risk] 现有生产部署依赖 root S3 凭据，升级后 core 会因新凭据缺失无法启动 → [Mitigation] 更新 `.env.prod.example` 和升级 Runbook，先创建应用用户并验证读写，再重启 core。
- [Risk] 轮换 JWT/TFA/数据库等密钥会造成会话失效或数据不可解密 → [Mitigation] Runbook 明确影响，要求轮换前备份，并将 TFA 密钥列为不可直接替换的高风险操作。
- [Risk] Compose 静态校验无法证明 MinIO 策略实际生效 → [Mitigation] 增加配置检查和文档中的 `mc admin policy info`/应用读写验证步骤；真实环境仍需 staging 演练。
- [Risk] #324 可能同时修改生产 Compose → [Mitigation] 将 #330 保持为独立配置护栏变更，合并前在最新 main 上重跑 Compose 校验并手工合并 Gateway 配置。

## Migration Plan

1. 生成并安全保存独立的 `S3_ACCESS_KEY`/`S3_SECRET_KEY`，按初始化策略创建应用用户。
2. 用 `mc` 或 staging smoke test 验证应用用户只能访问目标 bucket，并能完成支持包读写。
3. 更新 `.env.prod`，运行生产配置检查，再执行数据库迁移和 core 启动。
4. 确认 core 健康后撤销旧的 root 复用凭据路径；保留 MinIO root 凭据仅供受限运维使用。
5. 回滚时恢复上一版本 Compose 和应用凭据，但不得把 root 凭据重新注入 core；若 schema/密钥已切换，先按 Runbook 恢复备份。
