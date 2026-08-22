# 生产部署（公测）

> 本文档面向公测（Public Beta）部署。当前方案为单机 Docker Compose + ghcr.io 镜像，
> 数据库高可用、监控告警、日志聚合等可靠性/可观测性能力后续版本补充。

## 1. 前置条件

- 一台 Linux 服务器（amd64），已安装 Docker Engine 与 Docker Compose v2。
- 一个已解析到服务器的域名。
- 外部 TLS 终止（宿主机 Nginx / Caddy / 云负载均衡），负责 HTTPS → 容器 HTTP 端口。
- GitHub 仓库已启用 GitHub Container Registry（ghcr.io）权限。

## 2. 初始化

```bash
# 1) 获取项目（只需要部署文件与镜像，不需要源码运行）
git clone https://github.com/Neuro-OJ/neuro-oj.git
cd neuro-oj

# 2) 准备环境变量
cp .env.prod.example .env.prod
vim .env.prod
```

`.env.prod` 中必须填写：

| 变量 | 说明 |
|------|------|
| `NOJ_VERSION` | 要部署的 Release 标签，如 `v0.1.0` |
| `APP_URL` | `https://你的域名` |
| `CORS_ALLOWED_ORIGINS` | `https://你的域名` |
| `POSTGRES_PASSWORD` | PostgreSQL 强密码 |
| `REDIS_PASSWORD` | Redis 强密码 |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | MinIO 管理员/S3 凭证 |
| `JWT_SECRET` / `TFA_ENCRYPTION_KEY` | ≥32 字符随机串 |
| `ADMIN_EMAIL` / `ADMIN_PASS` | 公测管理员账号 |
| `JUDGE_IMAGE_BASE` | 默认 `ghcr.io/neuro-oj/` |
| `NGINX_PORT` | 容器 Nginx 映射到宿主机的端口，默认 `8080` |

```bash
# 3) 配置外部 TLS 终止
# 容器内的 Nginx 不处理 TLS；请在宿主机/云 LB 上配置 HTTPS，
# 并将解密后的 HTTP 流量转发到本机 ${NGINX_PORT:-8080} 端口（默认 8080）。
# 示例见 deploy/README.md。

# 4) 执行一次性初始化（迁移 + 系统数据 + 管理员）
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d migrate
docker compose --env-file .env.prod -f docker-compose.prod.yml logs migrate

# 5) 启动全部服务
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d

# 6) 查看状态
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
curl https://你的域名/healthz
```

## 3. 评测镜像白名单

生产初始化时 `init system` 会根据 `JUDGE_IMAGE_BASE` 写入 ghcr 全限定镜像名
（例如 `ghcr.io/neuro-oj/noj-evaluator-python`）。

如果是从旧数据库升级，或需要手工确认，请通过管理后台或 SQL 检查 `judge_images`：

```sql
SELECT image, mode, kind FROM judge_images ORDER BY kind;
```

应包含：

```text
ghcr.io/neuro-oj/noj-evaluator-python  all_versions  evaluator
ghcr.io/neuro-oj/noj-solution-python   all_versions  solution
```

## 4. 日常运维

```bash
# 查看服务状态
docker compose --env-file .env.prod -f docker-compose.prod.yml ps

# 查看日志
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f --tail=200 core
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f --tail=200 judge

# 健康检查（通过外部 TLS 终止后的地址）
curl https://你的域名/healthz

# 队列积压（需要进入 redis 容器或使用 redis-cli）
docker compose --env-file .env.prod -f docker-compose.prod.yml exec redis \
  redis-cli -a "$REDIS_PASSWORD" LLEN noj:judge:queue
```

## 5. 升级

1. 在 GitHub 发布新 Release（如 `v0.1.1`），`release.yml` 会自动推送镜像。
2. 在服务器修改 `.env.prod` 中的 `NOJ_VERSION=v0.1.1`。
3. 拉取新镜像并重建：

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml pull
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

4. 数据库迁移由 `core` 启动时自动执行；也可先手动跑一次 `migrate` 服务。

## 6. 回滚

- 将 `.env.prod` 的 `NOJ_VERSION` 改回上一版本，重新 `pull` + `up -d`。
- 数据库 schema 采用只追加迁移，**不自动回滚**；如需回退 schema，请人工评估并备份后操作。
- 评测镜像也按 Release tag 发布，回滚时需要把 `judge_images` 白名单指向旧 tag（若使用 `all_versions` 则无需改白名单，只需题目/系统设置中的镜像 tag 指向旧版本）。

## 7. 备份提示

当前公测方案尚未包含自动化备份/高可用，请至少定期备份：

- PostgreSQL：`pg_dump -F c` 或云数据库快照。
- Redis：AOF/RDB 文件（`redisdata` 卷）。
- MinIO：`miniodata` 卷或 bucket 同步到异地存储。
- `.env.prod`：包含密钥，务必加密保存。

详细可靠性方案后续版本补充。
