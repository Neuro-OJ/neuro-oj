# 生产密钥轮换 Runbook

本文档适用于 Docker Compose 生产部署。推荐使用 secrets manager 将值注入容器环境；若暂时使用 `.env.prod`，文件必须由部署用户持有并设置为 `chmod 600`，不得提交 Git、打入镜像或写入日志。

## 部署前检查

```bash
chmod 600 .env.prod
cd noj-core
deno task check:prod
cd ..
docker compose --env-file .env.prod -f docker-compose.prod.yml config >/dev/null
```

检查命令只输出配置键名和错误原因，不输出 secret 值。生产环境禁止已知占位符、mock 邮件 Provider 和 local 存储。

## S3/MinIO 应用凭据轮换

1. 生成新的 `S3_ACCESS_KEY` 和 `S3_SECRET_KEY`，确保它们与 `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` 不同。
2. 在维护窗口更新 `.env.prod`，运行 `docker compose config` 和 `deno task check:prod`。
3. 执行 `minio-init`，让目标 bucket 的应用策略和新用户生效：

   ```bash
   docker compose --env-file .env.prod -f docker-compose.prod.yml up --no-deps minio-init
   ```

4. 重启 `core` 和 `judge`，提交一个小型支持包题目验证读写和评测交付。
5. 确认新凭据可用后，在 MinIO 管理侧撤销旧应用用户；root 凭据只保留给受限运维操作。

应用策略只允许目标 bucket 的列举、读取、写入、删除和位置查询，不授予 MinIO 管理权限或其他 bucket 权限。使用 `mc admin policy info` 和一次实际读写验证记录结果。

## 邮件凭据轮换

1. 在邮件服务商创建新的 API 凭据，并确认发件域名/地址已验证。
2. 更新对应的 `ALIBABA_*` 或 `TENCENT_*` 配置，保留 `EMAIL_PROVIDER` 不变。
3. 运行生产配置检查并重启 `core`，执行密码重置邮件 smoke test。
4. 确认新凭据发送成功后，撤销旧凭据。

`EMAIL_PROVIDER=mock` 在生产环境会阻止 core 启动。

## Redis、PostgreSQL 和管理员凭据

1. 创建新凭据并先在 staging 验证连接。
2. 更新 secret 文件或 secrets manager，执行配置检查。
3. 先备份 PostgreSQL、Redis AOF/RDB、MinIO bucket 和当前配置，再重启对应服务。
4. 确认健康检查、登录、提交评测和结果回写正常后撤销旧凭据。

Redis/PostgreSQL 凭据轮换可能造成短暂不可用；应在维护窗口执行，并准备上一份配置用于回滚。

## JWT 与 TFA 密钥

- 轮换 `JWT_SECRET` 会使既有 JWT 会话失效，用户需要重新登录。
- 轮换 `TFA_ENCRYPTION_KEY` 可能使已保存的 TOTP secret 无法解密；除非已完成 TFA 数据迁移方案，否则不得直接替换。
- 轮换前必须完成数据库和配置备份，并记录影响范围；回滚时恢复旧 secret 后重启 `core`。

## 回滚与记录

每次轮换记录时间、变更人、受影响服务、旧凭据撤销时间和 smoke test 结果。出现失败时先停止继续撤销旧凭据，恢复上一份受限配置并重启服务；不得通过把 MinIO root 凭据注入 core 来绕过故障。
