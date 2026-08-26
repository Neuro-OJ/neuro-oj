# 生产部署（公测）

> 本文档面向公测（Public Beta）部署。当前方案为单机 Docker Compose + ghcr.io 镜像，
> 数据库高可用、监控告警、日志聚合等可靠性/可观测性能力后续版本补充。

## 1. 前置条件

- 一台 Linux 服务器（amd64），已安装 Docker Engine 与 Docker Compose v2。
- Deno 2.x（仅用于部署前运行 `noj-core` 的配置检查命令）。
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
chmod 600 .env.prod
vim .env.prod

# 生产部署前检查（不会打印 secret 明文）
docker compose --env-file .env.prod -f docker-compose.prod.yml config >/dev/null
cd noj-core && deno task check:prod
cd ..
```

也可以使用仓库提供的生产部署入口完成检查和启动：

```bash
bash scripts/deploy/deploy.sh install
```

首次执行会创建权限为 `600` 的 `.env.prod` 并生成部分随机密钥，然后停止并提示
填写域名、版本、邮件 Provider、管理员账号和 Judge 隔离 Docker socket。填写完成
后再次执行同一命令即可继续部署。

`.env.prod` 中必须填写：

| 变量 | 说明 |
|------|------|
| `NOJ_VERSION` | 要部署的 Release 标签，如 `v0.1.0` |
| `DOMAIN` | 对外域名（不含协议），compose/Nginx 使用 |
| `APP_URL` | `https://你的域名` |
| `CORS_ALLOWED_ORIGINS` | `https://你的域名` |
| `TRUSTED_PROXIES` | 可信代理网段，必须与 compose 中 `noj-net` 子网一致（如 `172.28.0.0/16`）；生产必填 |
| `NUXT_NOJ_ENV` | 前端环境标记，生产 HTTPS 环境保持 `production` |
| `POSTGRES_PASSWORD` | PostgreSQL 强密码 |
| `REDIS_PASSWORD` | Redis 强密码 |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | MinIO 管理员凭据，仅供 `minio-init` 使用 |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | 支持包 bucket 的最小权限应用凭据 |
| `STORAGE_PROVIDER` / `S3_ENDPOINT` / `S3_BUCKET` | 生产必须使用 S3/MinIO |
| `S3_REGION` | 可选，默认 `us-east-1` |
| `S3_FORCE_PATH_STYLE` | 自建 MinIO 通常为 `true` |
| `JWT_SECRET` / `TFA_ENCRYPTION_KEY` | ≥32 字符随机串 |
| `ADMIN_EMAIL` / `ADMIN_PASS` | 公测管理员账号 |
| `EMAIL_PROVIDER` 及对应凭据 | 生产必须使用 aliyun 或 tencent，禁止 mock |
| `JUDGE_IMAGE_BASE` | 默认 `ghcr.io/neuro-oj/` |
| `NGINX_PORT` | 容器 Nginx 映射到宿主机的端口，默认 `8080` |
| `JUDGE_DOCKER_SOCKET` / `JUDGE_DOCKER_SOCKET_GID` | 独立 rootless Docker daemon 的 socket 与组 ID；禁止使用 `/var/run/docker.sock` |
| `NOJ_LLM_SERVICE_TOKEN` | LLM Gateway 服务间鉴权 + eval_token 签发/校验密钥（≥16 字符）；compose 默认始终启动 `llm-gateway`，因此生产**必须填写** |
| `NOJ_LLM_STORE_KEY` | LLM Gateway 加密 Provider API Key 的信封主密钥（≥16 字符）；compose 默认必填 |
| `JUDGE_ALLOW_EVALUATOR_NETWORK` | 是否允许 evaluator 联网；使用 LLM 调用题时必须设为 `true` |
| `JUDGE_EVALUATOR_NETWORK` | evaluator 联网时加入的 Docker 网络；生产必须指向 `llm-gateway` 所在网络，默认 `noj-net` |
| `JUDGE_ALLOW_HTTP_S3` | 自建 MinIO 走内网 HTTP 时设为 `true`，允许 judge 通过 HTTP 下载支持包 |

```bash
# 3) 配置外部 TLS 终止
# 容器内的 Nginx 不处理 TLS；请在宿主机/云 LB 上配置 HTTPS，
# 并将解密后的 HTTP 流量转发到本机 ${NGINX_PORT:-8080} 端口（默认 8080）。
# 示例见 deploy/README.md。

# 4) 手动方式：执行一次性初始化（迁移 + 系统数据 + 管理员）
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d migrate
docker compose --env-file .env.prod -f docker-compose.prod.yml logs migrate

# 5) 手动方式：启动全部服务
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d

# 6) 查看状态
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
curl https://你的域名/healthz
```

使用部署脚本时，上述初始化、启动和健康检查由以下命令统一完成：

```bash
bash scripts/deploy/deploy.sh install
```

> 评测 Worker 不得挂载应用宿主机的 `/var/run/docker.sock`。生产 Compose 要求
> `JUDGE_DOCKER_SOCKET` 指向只服务于 judge 的 rootless daemon socket，并以非 root
> 用户运行 Worker；`JUDGE_REQUIRE_ISOLATED_DOCKER=true` 会在错误配置时阻止 Worker
> 消费评测任务。

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

## 3.5 LLM Gateway 部署

`docker-compose.prod.yml` 默认启动 `llm-gateway` 容器，并让 core 通过
`http://llm-gateway:8001` 访问。由于 compose 对 `NOJ_LLM_SERVICE_TOKEN` 和
`NOJ_LLM_STORE_KEY` 使用 `${...:?}` 必填校验，即使不使用 LLM 调用题也必须
在 `.env.prod` 中填写这两个密钥。

使用 LLM 调用题时：

- 必须设置 `NOJ_LLM_SERVICE_TOKEN` 与 `NOJ_LLM_STORE_KEY`，且 `NOJ_LLM_SERVICE_TOKEN`
  与 noj-core 保持一致。
- 必须开启 evaluator 联网：`JUDGE_ALLOW_EVALUATOR_NETWORK=true`。
- `JUDGE_EVALUATOR_NETWORK` 必须指向 `llm-gateway` 所在网络（compose 中为 `noj-net`），
  否则 evaluator 容器无法解析 `http://llm-gateway:8001`。
- 在管理后台「LLM Providers」配置上游 OpenAI 兼容服务；Provider Key 仅加密存储在数据库。

密钥轮换：

- 轮换 `NOJ_LLM_SERVICE_TOKEN` 会让所有未过期 eval_token 失效，需同步更新 noj-core 与 gateway。
- 轮换 `NOJ_LLM_STORE_KEY` 后，需要用新主密钥重新加密所有 Provider Key。

## 4. staging 验收门禁

生产候选版本必须先在 staging 使用与生产相同的 Compose 文件和六类镜像完成验收，
再进入 Release。验收脚本要求工作树洁净，默认只接受 `main`、`release/*` 或版本
标签；生产验收不得使用 `latest` 作为版本标识。

准备验收环境文件：

```bash
cp scripts/staging/env.example .env.staging
chmod 600 .env.staging
vim .env.staging
```

其中 `STAGING_BASE_URL` 必须是已经配置好外部 TLS 终止和反向代理的 HTTPS 地址，
`STAGING_CORS_ORIGIN` 必须与浏览器实际来源一致。执行完整验收：

```bash
bash scripts/staging/acceptance.sh all \
  --env-file .env.staging \
  --artifact-dir artifacts/staging/$(grep '^NOJ_VERSION=' .env.staging | cut -d= -f2)
```

脚本会构建并启动 `noj-core`、`noj-ui`、`noj-judge`、`noj-llm-gateway`、
`noj-evaluator-python`、`noj-solution-python` 六类生产镜像，然后依次验证：

- Compose 健康检查、`/healthz`、HTTPS、CORS，以及 `HttpOnly`/`Secure`/`SameSite=Lax` Cookie；
- 管理员登录与强制改密、普通用户登录、TFA 启用与登录；
- 题包导入、S3/MinIO 支持包下载、真实代码提交与完整评测；
- 提交 SSE 推送和管理员重测。

失败时不会自动清理 staging 服务，并将 `compose ps`、最近 500 行服务日志、Docker
信息和版本元数据写入报告目录；修复后应重新执行完整验收。成功时默认停止服务但保留
数据卷，调试时可加 `--keep-stack` 保留服务。仅本地调试允许使用 `--allow-http`。

发布前人工确认清单：

1. staging 验收报告为成功，且包含候选提交、镜像仓库/版本和数据库迁移结果。
2. 失败日志与已知限制已归档，未遗留未处理的队列、容器或数据问题。
3. 已创建并验证 GPG 签名的提交或版本标签。
4. 发布负责人完成手工批准后，才执行 GitHub Release 和生产升级。

## 5. 日常运维

推荐使用部署脚本：

```bash
bash scripts/deploy/deploy.sh status
bash scripts/deploy/deploy.sh logs core
bash scripts/deploy/deploy.sh logs judge --follow
bash scripts/deploy/deploy.sh backup
```

`backup` 只创建 PostgreSQL custom-format 备份；Redis、MinIO 和 `.env.prod` 的备份
仍需按照 [备份与灾备 Issue #326](https://github.com/Neuro-OJ/neuro-oj/issues/326)
另行规划，备份文件默认保存在仓库根目录的 `backups/` 且权限为 `600`。

```bash
# 查看服务状态
docker compose --env-file .env.prod -f docker-compose.prod.yml ps

# 查看日志
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f --tail=200 core
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f --tail=200 judge
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f --tail=200 llm-gateway

# 健康检查（通过外部 TLS 终止后的地址）
curl https://你的域名/healthz

# 队列积压（需要进入 redis 容器或使用 redis-cli）
docker compose --env-file .env.prod -f docker-compose.prod.yml exec redis \
  redis-cli -a "$REDIS_PASSWORD" LLEN noj:judge:queue
```

## 6. 升级

1. 在 GitHub 发布新 Release（如 `v0.1.1`），`release.yml` 会自动推送镜像。
2. 在服务器修改 `.env.prod` 中的 `NOJ_VERSION=v0.1.1`。
3. 拉取新镜像并重建：

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml pull
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

4. 数据库迁移由 `core` 启动时自动执行；也可先手动跑一次 `migrate` 服务。

## 7. 回滚

- 将 `.env.prod` 的 `NOJ_VERSION` 改回上一版本，重新 `pull` + `up -d`。
- 数据库 schema 采用只追加迁移，**不自动回滚**；如需回退 schema，请人工评估并备份后操作。
- 评测镜像也按 Release tag 发布，回滚时需要把 `judge_images` 白名单指向旧 tag（若使用 `all_versions` 则无需改白名单，只需题目/系统设置中的镜像 tag 指向旧版本）。

## 8. 备份提示

当前公测方案尚未包含自动化备份/高可用，请至少定期备份：

- PostgreSQL：`pg_dump -F c` 或云数据库快照。
- Redis：AOF/RDB 文件（`redisdata` 卷）。
- MinIO：`miniodata` 卷或 bucket 同步到异地存储。
- `.env.prod`：包含密钥，文件权限设为 `600`，并使用 secrets manager 或加密存储保存。

密钥轮换和失效步骤见[生产密钥轮换 Runbook](./production-secrets)。
