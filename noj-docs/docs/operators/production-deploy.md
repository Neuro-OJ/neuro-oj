# 生产部署（公测）

> 本文档面向公测（Public Beta）部署。当前方案为单机 Docker Compose + ghcr.io 镜像，
> 数据库高可用、监控告警、日志聚合等可靠性/可观测性能力后续版本补充。

## 1. 前置条件

- 一台 Linux 服务器（amd64），已安装 Docker Engine 与 Docker Compose v2。
- 已安装 Cosign（用于校验生产应用镜像的 keyless 签名）；Docker CLI 可用 Buildx。
- Deno 2.x（仅用于部署前运行 `noj-core` 的配置检查命令）。
- 一个已解析到服务器的域名。
- 外部 TLS 终止（宿主机 Nginx / Caddy / 云负载均衡），负责 HTTPS → 容器 HTTP 端口。
- GitHub 仓库已启用 GitHub Container Registry（ghcr.io）权限。

## 2. 初始化

```bash
# 只下载一个 bootstrap 脚本；生产环境建议固定到 Release tag
curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/scripts/deploy/install.sh \
  -o noj-install.sh
chmod +x noj-install.sh

# 下载指定版本源码并调用生产部署入口
sudo bash noj-install.sh --ref v0.1.0 --dir /opt/neuro-oj
```

首次执行会将源码放入 `/opt/neuro-oj`，随后创建权限为 `600` 的 `.env.prod` 并生成
部分随机密钥，然后停止并提示填写配置。编辑配置后重新执行：

```bash
sudo vim /opt/neuro-oj/.env.prod
sudo chmod 600 /opt/neuro-oj/.env.prod
sudo bash /opt/neuro-oj/scripts/deploy/deploy.sh install
```

bootstrap 默认使用 `v0.1.0`，可通过 `--ref` 指定其他分支或 Release tag；生产环境应
使用不可变 Release tag，并让 `--ref` 与 `.env.prod` 中的 `NOJ_VERSION` 保持一致。
也可以使用 `--download-only` 只获取源码，或使用 `--dry-run` 查看下载计划。目标目录
非空时 bootstrap 会拒绝覆盖已有 `.env.prod`、备份和部署文件；已有安装请直接执行
`/opt/neuro-oj/scripts/deploy/deploy.sh upgrade`。

如果不希望在 shell 中直接执行网络下载内容，可以先保存脚本并人工检查；确认后再运行
上面的 `sudo bash noj-install.sh ...`。bootstrap 只依赖 Linux 上常见的 Bash、`curl`
或 `wget`、`tar`，实际服务部署仍需要 Docker Engine 与 Docker Compose v2。

`.env.prod` 中必须填写：

| 变量 | 说明 |
|------|------|
| `NOJ_VERSION` | 要部署的已签名 Release 标签，如 `v0.1.0`；禁止使用 `latest`/`beta` |
| `NOJ_ENFORCE_IMAGE_SIGNATURES` | 生产必须保持 `true`，启动/升级前校验六个应用镜像的 Cosign 签名 |
| `NOJ_COSIGN_CERT_IDENTITY_REGEX` | Cosign 证书身份正则，默认只信任本仓库的 Release workflow |
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
| `NOJ_LLM_USER_RATE_LIMIT_PER_MINUTE` | 每个用户每 UTC 分钟的 LLM 调用上限；可选，默认 `60`，必须为正整数 |
| `NOJ_LLM_IP_RATE_LIMIT_PER_MINUTE` | 每个 IP 每 UTC 分钟的 LLM 调用上限；可选，默认 `60`，必须为正整数 |
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

部署脚本在 `install`、`start` 和 `upgrade` 前会校验 `NOJ_VERSION` 对应的六个应用镜像
digest 与 Cosign keyless 签名。默认信任当前仓库的 Release workflow；如需变更签名身份，
必须通过受保护的生产配置显式设置 `NOJ_COSIGN_CERT_IDENTITY_REGEX`。可以单独执行：

```bash
bash scripts/deploy/deploy.sh verify
```

`NOJ_ENFORCE_IMAGE_SIGNATURES=false` 仅用于本地 fake-Docker 测试，不得用于生产环境。
成功启动或升级后，脚本会在 `backups/current-deployment.txt` 记录当前 Release 版本和六个
应用镜像 digest；升级失败时不会覆盖上一份成功部署记录。

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

用户和 IP 分钟限流分别由 `NOJ_LLM_USER_RATE_LIMIT_PER_MINUTE` 与
`NOJ_LLM_IP_RATE_LIMIT_PER_MINUTE` 配置，缺失时均为每 UTC 分钟 60 次。
配置必须是正整数，并在 `llm-gateway` 重启后生效；其它日/月调用量、Token 和费用配额不受影响。

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
bash scripts/deploy/deploy.sh backup --passphrase-file /etc/noj/backup-passphrase
```

`backup` 会创建包含 PostgreSQL、Redis RDB、MinIO/S3 对象镜像和 GPG 加密
`.env.prod` 的完整快照。快照目录位于 `backups/snapshot-*`，目录权限为 `700`，
文件权限不对其他用户开放；组件失败时不会留下可被误用的半成品快照。

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

1. 在 GitHub 发布新 Release（如 `v0.1.1`）。Release workflow 会先构建候选镜像，
   完成漏洞扫描、SBOM、签名和来源证明后，才创建正式版本标签。
2. 确认 Release workflow 的六个镜像验证全部成功，并在服务器修改 `.env.prod` 中的
   `NOJ_VERSION=v0.1.1`。
3. 升级前创建备份并拉取新镜像：

```bash
bash scripts/deploy/deploy.sh upgrade
```

部署脚本会先校验镜像签名，再创建并校验生产备份，然后拉取镜像并等待 Compose 健康检查。
数据库迁移由 `migrate` 一次性服务执行；升级前必须确认新版本迁移与旧版本应用兼容。

## 7. 回滚

- 确认上一版本 Release 仍可拉取且签名有效，将 `.env.prod` 的 `NOJ_VERSION` 改回上一版本，
  执行 `bash scripts/deploy/deploy.sh verify` 后再执行 `bash scripts/deploy/deploy.sh start`。
- 数据库 schema 采用只追加迁移，**不自动回滚**；如需回退 schema，请人工评估并备份后操作。
- 评测镜像也按 Release tag 发布，回滚时需要把 `judge_images` 白名单指向旧 tag（若使用 `all_versions` 则无需改白名单，只需题目/系统设置中的镜像 tag 指向旧版本）。

如果新版本已经执行了不兼容的数据库迁移，不能只切换应用镜像；必须停止服务、确认备份
可恢复后，按备份恢复流程处理数据，再启动上一版本。

## 8. 备份提示

### 8.1 初始化口令与创建快照

备份口令只保存在仓库外的受限文件中，不要写入 `.env.prod` 或提交到 Git：

```bash
sudo install -d -m 700 /etc/noj
openssl rand -hex 32 | sudo tee /etc/noj/backup-passphrase >/dev/null
sudo chmod 600 /etc/noj/backup-passphrase

export NOJ_BACKUP_PASSPHRASE_FILE=/etc/noj/backup-passphrase
bash scripts/deploy/deploy.sh backup --backup-dir /srv/noj/backups
```

每次快照都会生成 SHA-256 清单、PostgreSQL dump 结构清单、迁移状态和 `SUCCESS`
标记；默认保留 30 天，默认要求备份目录至少有 1GiB 可用空间。可通过
`NOJ_BACKUP_RETENTION_DAYS` 和 `NOJ_BACKUP_MIN_FREE_MB` 调整。

### 8.2 校验、恢复与恢复演练

```bash
snapshot=/srv/noj/backups/snapshot-YYYYMMDD-HHMMSS
bash scripts/deploy/backup.sh verify "$snapshot"
bash scripts/deploy/backup.sh drill "$snapshot" --report /srv/noj/restore-drill.txt
```

`drill` 不会触碰当前生产数据，只验证解密、校验和、PostgreSQL 结构、Redis RDB
以及对象镜像。周期性演练应在隔离 Compose project 中执行实际恢复：

```bash
bash scripts/deploy/backup.sh restore "$snapshot" \
  --project-name noj-restore-drill \
  --restore-env /srv/noj/restore-drill.env \
  --confirm
```

恢复会覆盖目标数据库、Redis 数据和对象存储，因此必须显式 `--confirm`，且目标
Compose 服务必须已经停止。建议恢复到单独主机或单独数据卷，人工检查后再启动业务
服务；脚本不会执行 `down -v`，也不会删除生产数据卷。

### 8.3 RPO/RTO 与自动化

- 默认快照是 PostgreSQL 完整逻辑备份；Redis 使用 RDB，评测队列属于可恢复的瞬态
  数据，故障后允许重新提交或重新入队。
- 可按 6 小时执行一次 `backup`，将业务 RPO 目标设为不超过 6 小时；实际 RPO 取决于
  调度器是否成功完成并收到告警。需要分钟级 RPO 时，应额外配置 PostgreSQL WAL/PITR
  和异地对象存储，不能只依赖本脚本。
- RTO 由 PostgreSQL 数据量、对象数量和网络决定。每月至少在隔离环境跑一次实际
  `restore --confirm`，记录从快照开始到健康检查通过的耗时，作为真实 RTO 基线。
- 建议由 systemd timer、cron 或外部调度平台执行 `backup.sh create`，并对非零退出码、
  磁盘空间不足、`verify` 失败和恢复演练失败发送告警。备份目录应同步到与生产主机
  不同故障域的加密存储。

密钥轮换和失效步骤见[生产密钥轮换 Runbook](./production-secrets)。
