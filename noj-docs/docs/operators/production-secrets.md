# 生产密钥轮换 Runbook

本文档适用于 Docker Compose 生产部署。推荐使用 secrets manager 将值注入容器环境；未接入 secrets manager 时，可将密钥写入 `noj-secrets.json`（权限 600），不得提交 Git、打入镜像或写入日志。

## 部署前检查

```bash
chmod 600 /opt/neuro-oj/noj-secrets.json
cd noj-core
    deno task check:prod  # 可选；生产一键部署不依赖 Deno
cd ..
docker compose -f /opt/neuro-oj/docker-compose.noj.yml config >/dev/null
```

检查命令只输出配置键名和错误原因，不输出 secret 值。生产环境禁止已知占位符、mock 邮件 Provider 和 local 存储。

## S3/MinIO 应用凭据轮换

1. 生成新的 `S3_ACCESS_KEY` 和 `S3_SECRET_KEY`，确保它们与 `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` 不同。
2. 在维护窗口更新 `noj-secrets.json`，运行 `docker compose -f /opt/neuro-oj/docker-compose.noj.yml config` 和 `deno task check:prod`。
3. 执行 `minio-init`，让目标 bucket 的应用策略和新用户生效：

   ```bash
   docker compose -f /opt/neuro-oj/docker-compose.noj.yml up --no-deps minio-init
   ```

4. 重启 `server` 和 `judge`，提交一个小型支持包题目验证读写和评测交付。
5. 确认新凭据可用后，在 MinIO 管理侧撤销旧应用用户；root 凭据只保留给受限运维操作。

应用策略只允许目标 bucket 的列举、读取、写入、删除和位置查询，不授予 MinIO 管理权限或其他 bucket 权限。使用 `mc admin policy info` 和一次实际读写验证记录结果。

## 邮件凭据轮换

1. 在邮件服务商创建新的 API 凭据，并确认发件域名/地址已验证。
2. 更新对应的 `ALIBABA_*` 或 `TENCENT_*` 配置，保留 `EMAIL_PROVIDER` 不变。
3. 运行生产配置检查并重启 `server`，执行密码重置邮件 smoke test。
4. 确认新凭据发送成功后，撤销旧凭据。

`EMAIL_PROVIDER=mock` 在生产环境会阻止 server 启动。

## Redis、PostgreSQL 和管理员凭据

1. 创建新凭据并先在 staging 验证连接。
2. 更新 secret 文件或 secrets manager，执行配置检查。
3. 先备份 PostgreSQL、Redis AOF/RDB、MinIO bucket 和当前配置，再重启对应服务。
4. 确认健康检查、登录、提交评测和结果回写正常后撤销旧凭据。

Redis/PostgreSQL 凭据轮换可能造成短暂不可用；应在维护窗口执行，并准备上一份配置用于回滚。

## JWT 与 TFA 密钥

- 轮换 `JWT_SECRET` 会使既有 JWT 会话失效，用户需要重新登录。
- 轮换 `TFA_ENCRYPTION_KEY` 可能使已保存的 TOTP secret 无法解密；除非已完成 TFA 数据迁移方案，否则不得直接替换。
- 轮换前必须完成数据库和配置备份，并记录影响范围；回滚时恢复旧 secret 后重启 `server`。

## LLM Gateway 与 BYOK 密钥

- `NOJ_LLM_STORE_KEY` 是 `noj-llm-gateway` 保存平台 Provider 和用户 BYOK API Key 的信封加密主密钥。生产环境必须通过 secrets manager 注入，不能写入镜像、日志或 Git。
- `NOJ_LLM_SERVICE_TOKEN` 同时用于 Core/Judge 与 Gateway 的受信调用；轮换时先更新 Gateway 和 Core/Judge 的一致配置，再滚动重启并验证平台 LLM 与用户 BYOK 测试连接。
- `NOJ_LLM_BYOK_ALLOWED_HOSTS` 是用户 Provider 的精确主机 allowlist。新增主机前应完成供应商归属和 HTTPS 验证；不要为了兼容本地服务而放开 localhost、私网或元数据地址。
- Gateway 日志和用量记录只保留 Provider、模型、状态和摘要元数据，不应出现 API Key、Authorization、prompt 或完整 Provider 错误 body。

## 回滚与记录

每次轮换记录时间、变更人、受影响服务、旧凭据撤销时间和 smoke test 结果。出现失败时先停止继续撤销旧凭据，恢复上一份受限配置并重启服务；不得通过把 MinIO root 凭据注入 server 来绕过故障。
