# 生产部署（公测）

> 本文档面向公测（Public Beta）部署。当前方案为单机 Docker Compose + ghcr.io 镜像，
> 数据库高可用、监控告警、日志聚合等可靠性/可观测性能力后续版本补充。

## 1. 前置条件

### 宝塔等服务器面板

宝塔等服务器面板与普通部署复用同一套 `noj-cli` 流程，不提供面板专用脚本或参数。
部署完成后只需在面板中将域名反向代理到 `127.0.0.1:NGINX_PORT`（默认 `8080`）；
Judge 仍需使用独立的 rootless Docker socket，不能改用 `/run/docker.sock` 或
`/var/run/docker.sock`。

- 一台 Linux 服务器（amd64），已安装 Docker Engine 与 Docker Compose v2。
- Docker CLI 可用 Buildx；Cosign 不是默认安装条件，只有开启严格镜像签名校验时才需要。
- Deno 2.x（可选，仅用于部署前运行 `noj-server` 的配置检查命令；一键生产部署不依赖 Deno）。
- 一个已解析到服务器的域名。
- 外部 TLS 终止（宿主机 Nginx / Caddy / 云负载均衡），负责 HTTPS → 容器 HTTP 端口。
- 能够访问 `ghcr.io/neuro-oj/` 镜像；私有镜像还需要配置相应凭据。

## 2. 初始化

### 推荐：下载 noj-cli 后开始安装

NOJ 的唯一安装入口是 `noj-cli` 二进制。直接从 GitHub Releases 下载，然后交给
`noj-cli` 完成环境检测（doctor）与生产部署（deploy init / deploy up）：

```bash
# 下载最新版 noj-cli
curl -fsSL -o noj-cli \
  https://github.com/Neuro-OJ/neuro-oj/releases/latest/download/noj-cli-linux-amd64
chmod +x noj-cli

# 环境检测
./noj-cli doctor

# 初始化并部署（示例目录 /opt/neuro-oj）
./noj-cli deploy init --mode prod --dir /opt/neuro-oj
./noj-cli deploy up --dir /opt/neuro-oj
```

固定版本时把 `releases/latest` 换成 `releases/download/vX.Y.Z`，例如：

```bash
curl -fsSL -o noj-cli \
  https://github.com/Neuro-OJ/neuro-oj/releases/download/v0.1.0/noj-cli-linux-amd64
```

安装完成后打开网站注册第一个真实用户，该用户会自动获得管理员权限，不需要再执行额外
的提权命令。已有站点的用户和管理员权限不会因为升级改变。

`setup.sh`、`scripts/deploy/*.sh` 与根目录 `noj` 旧命令均已移除，统一使用 `noj-cli`。

当前 Release 镜像仅发布 `linux/amd64`。ARM64/aarch64 主机请在下载前确认选择了
对应架构的版本，或在 `noj-cli doctor` 阶段处理架构不匹配提示。

### 配置模型

部署配置统一由 `noj-cli` 管理，**不再使用 `.env.prod`**：

| 文件 | 权限 | 内容 |
|---|---|---|
| `noj-deploy.json` | 644 | 部署类型、版本、组件、全局 env、反向代理 |
| `noj-secrets.json` | 600 | 数据库/Redis/JWT/OAuth/LLM 等全部密钥 |

`deploy init` 会生成这两个文件并随机填充密钥。之后可用
`noj-cli maintain config check/show/set` 查看和修改，也可以直接编辑 JSON。
配置中的环境变量名沿用原 `.env.prod` 的约定，但**不再以 env 文件形式存在**。

### 初始化、启动与健康检查

```bash
./noj-cli deploy init --mode prod --dir /opt/neuro-oj
./noj-cli deploy up --dir /opt/neuro-oj
./noj-cli deploy status --dir /opt/neuro-oj
curl https://你的域名/healthz
```

### 常用配置项

| 配置项 | 说明 |
|---|---|
| `version.noj_server`（对应原 `NOJ_VERSION`） | 要部署的已签名 Release 标签，如 `v0.1.0`；禁止使用 `latest`/`beta` |
| `env.NOJ_ENFORCE_IMAGE_SIGNATURES` | 默认 `false`；设为 `true` 后，启动/升级前校验已启用应用镜像的 Cosign 签名 |
| `env.NOJ_COSIGN_CERT_IDENTITY_REGEX` | Cosign 证书身份正则，默认只信任本仓库的 Release workflow |
| `env.DOMAIN` | 网站地址，可填域名或服务器 IP，不要写 `https://` |
| `env.APP_URL` | 完整应用地址，例如 `https://你的域名` |
| `env.NOJ_ALLOW_INSECURE_HTTP` | 临时 HTTP 开关，默认 `false`；正式环境请保持关闭 |
| `env.CORS_ALLOWED_ORIGINS` | `https://你的域名` |
| `env.TRUSTED_PROXIES` | 可信代理网段，必须与 compose 中 `noj-net` 子网一致（如 `172.28.0.0/16`）；生产必填 |
| `env.NUXT_NOJ_ENV` | 前端环境标记，生产环境保持 `production` |
| `secrets.POSTGRES_PASSWORD` | PostgreSQL 强密码 |
| `secrets.REDIS_PASSWORD` | Redis 强密码 |
| `secrets.MINIO_ROOT_USER` / `secrets.MINIO_ROOT_PASSWORD` | MinIO 管理员凭据 |
| `secrets.S3_ACCESS_KEY` / `secrets.S3_SECRET_KEY` | 支持包 bucket 的最小权限应用凭据 |
| `env.STORAGE_PROVIDER` / `env.S3_ENDPOINT` / `env.S3_BUCKET` | 生产必须使用 S3/MinIO |
| `env.S3_REGION` | 可选，默认 `us-east-1` |
| `env.S3_FORCE_PATH_STYLE` | 自建 MinIO 通常为 `true` |
| `secrets.JWT_SECRET` / `secrets.TFA_ENCRYPTION_KEY` | ≥32 字符随机串 |
| 首个管理员 | 安装完成后注册的第一个真实用户自动获得管理员权限；已有站点不会因升级自动提权 |
| `env.EMAIL_PROVIDER` 及对应凭据 | 可选阿里云、腾讯云或 `disabled`（暂不配置邮件） |
| `env.JUDGE_IMAGE_BASE` | 默认 `ghcr.io/neuro-oj/` |
| `env.NGINX_PORT` | 容器 Nginx 映射到宿主机的端口，默认 `8080` |
| `env.JUDGE_DOCKER_SOCKET` / `env.JUDGE_DOCKER_SOCKET_GID` | 独立 rootless Docker daemon 的 socket 与组 ID；禁止使用 `/var/run/docker.sock` |
| `secrets.OAUTH_GITHUB_CLIENT_ID` / `secrets.OAUTH_GITHUB_CLIENT_SECRET` | 可选；同时填写后启用 GitHub 登录。回调地址为 `APP_URL/api/v1/auth/oauth/github/callback` |
| `secrets.OAUTH_OIDC_ISSUER_URL` / `secrets.OAUTH_OIDC_CLIENT_ID` / `secrets.OAUTH_OIDC_CLIENT_SECRET` | 可选；同时填写后启用通用 OIDC 登录。回调地址为 `APP_URL/api/v1/auth/oauth/oidc/callback` |
| `env.OAUTH_OIDC_NAME` | 可选；OIDC 登录按钮名称，默认 `OIDC` |
| `components.judge.enabled`（对应原 `JUDGE_ENABLED`） | 是否安装和启动评测服务 Judge，默认 `true`；设为 `false` 可跳过 |
| `env.JUDGE_DOCKER_SOCKET` / `env.JUDGE_DOCKER_SOCKET_GID` | `components.judge.enabled=true` 时必填：独立 rootless Docker 服务的 socket 与组 ID；禁止使用 `/var/run/docker.sock` |
| `secrets.NOJ_LLM_SERVICE_TOKEN` | LLM Gateway 服务间鉴权 + eval_token 签发/校验密钥（≥16 字符） |
| `secrets.NOJ_LLM_STORE_KEY` | LLM Gateway 加密 Provider API Key 的信封主密钥（≥16 字符） |
| `env.NOJ_LLM_USER_RATE_LIMIT_PER_MINUTE` | 每个用户每 UTC 分钟的 LLM 调用上限；可选，默认 `60`，必须为正整数 |
| `env.NOJ_LLM_IP_RATE_LIMIT_PER_MINUTE` | 每个 IP 每 UTC 分钟的 LLM 调用上限；可选，默认 `60`，必须为正整数 |
| `env.JUDGE_ALLOW_EVALUATOR_NETWORK` | 是否允许 evaluator 联网；使用 LLM 调用题时必须设为 `true` |
| `env.JUDGE_EVALUATOR_NETWORK` | evaluator 联网时加入的 Docker 网络；生产必须指向 `llm-gateway` 所在网络，默认 `noj-net` |
| `env.JUDGE_ALLOW_HTTP_S3` | 自建 MinIO 走内网 HTTP 时设为 `true`，允许 judge 通过 HTTP 下载支持包 |

镜像签名校验默认关闭，以免阻断普通一键部署；如果需要严格校验，请安装 Cosign 并将
`env.NOJ_ENFORCE_IMAGE_SIGNATURES=true`，然后执行 `noj-cli maintain verify --dir /opt/neuro-oj`。
`noj-cli deploy up` 会按 Compose 拉取新镜像并等待健康检查；当前版本与镜像 digest
由 noj-cli 记录在部署目录中。

> 如果启用评测 Worker，不得挂载应用宿主机的 `/var/run/docker.sock`。生产 Compose 要求
> `JUDGE_DOCKER_SOCKET` 指向只服务于 judge 的 rootless daemon socket，并以非 root
> 用户运行 Worker；`JUDGE_REQUIRE_ISOLATED_DOCKER=true` 会在错误配置时阻止 Worker
> 消费评测任务。rootless Docker 的安装方式见
> [Judge Worker 运维 - rootless Docker 安装](judge-workers.md#rootless-docker-安装)。
> 跳过 Judge 时不需要这些配置。

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
ghcr.io/neuro-oj/noj-solution-ai       all_versions  solution
```

产物提交题使用 `noj-solution-python` 或 `noj-solution-ai` 运行 zip 产物；发布前应确认相应镜像已推送并被加入白名单。

## 3.5 LLM Gateway 部署

noj-cli 生成的部署默认启动 `llm-gateway` 容器，并让 core 通过
`http://llm-gateway:8001` 访问。即使不使用 LLM 调用题，也必须在
`noj-secrets.json` 中填写 `NOJ_LLM_SERVICE_TOKEN` 和 `NOJ_LLM_STORE_KEY`。

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

- 轮换 `NOJ_LLM_SERVICE_TOKEN` 会让所有未过期 eval_token 失效，需同步更新 noj-server 与 gateway。
- 轮换 `NOJ_LLM_STORE_KEY` 后，需要用新主密钥重新加密所有 Provider Key。

## 4. staging 验收门禁

生产候选版本必须先在 staging 使用与生产相同的 Compose 文件和七类镜像完成验收，
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

脚本会构建并启动 `noj-server`、`noj-ui`、`noj-judge`、`noj-llm-gateway`、
`noj-evaluator-python`、`noj-solution-python`、`noj-solution-ai` 七类生产镜像，然后依次验证：

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

安装完成后，推荐使用 `noj-cli` 命令统一管理生产服务：

```bash
noj-cli doctor
noj-cli deploy status
noj-cli maintain logs server
noj-cli maintain logs judge --follow
noj-cli deploy restart
noj-cli deploy down
noj-cli deploy up
noj-cli maintain backup create --passphrase-file /etc/noj/backup-passphrase
noj-cli maintain config check
```

`noj-cli` 不提供升级/卸载子命令；配置变更与数据管理见 `noj-cli maintain config`
与 `noj-cli maintain reset`。`deploy down` 不会删除数据卷；`maintain reset` 默认
只清数据，`--include-deploy-configs` 才连配置一起清。首次安装直接下载
`noj-cli` 二进制即可，没有 `setup.sh` 薄引导。

`maintain backup create` 会创建包含 PostgreSQL、Redis RDB、MinIO/S3 对象镜像和
GPG 加密配置的完整快照，产物为单个 `snapshot-<timestamp>.nojbackup`。

```bash
# 查看服务状态
noj-cli deploy status --dir /opt/neuro-oj

# 查看日志
noj-cli maintain logs server --dir /opt/neuro-oj
noj-cli maintain logs judge --follow --dir /opt/neuro-oj
noj-cli maintain logs llm_gateway --dir /opt/neuro-oj

# 健康检查（通过外部 TLS 终止后的地址）
curl https://你的域名/healthz

# 队列积压（密码从 noj-secrets.json 读取）
docker exec noj-redis redis-cli -a '<REDIS_PASSWORD>' LLEN noj:judge:queue
```

## 6. 升级

1. 在 GitHub 发布新 Release（如 `v0.1.1`）。Release workflow 会先构建候选镜像，
   完成漏洞扫描、SBOM、签名和来源证明后，才创建正式版本标签。
2. 确认 Release workflow 的全部镜像验证成功；固定版本部署可在服务器修改
   `noj-deploy.json` 中的 `version.noj_server=v0.1.1`（或执行
   `noj-cli maintain config set version.noj_server v0.1.1`）。
3. 升级前创建备份，然后更新配置并重新部署：

```bash
noj-cli maintain backup create --dir /opt/neuro-oj
noj-cli maintain config set version.noj_server v0.1.1
noj-cli deploy up --dir /opt/neuro-oj
```

`deploy up` 会按 Compose 拉取新镜像并等待健康检查；数据库迁移由 `migrate` 一次性服务执行。
升级前必须确认新版本迁移与旧版本应用兼容，并先完成备份。

## 7. 回滚

- 确认上一版本 Release 仍可拉取且签名有效，将 `noj-deploy.json` 的
  `version.noj_server` 改回上一版本（或执行
  `noj-cli maintain config set version.noj_server <上一版本>`），
  再执行 `noj-cli maintain verify --dir /opt/neuro-oj` 和
  `noj-cli deploy up --dir /opt/neuro-oj`。
- 数据库 schema 采用只追加迁移，**不自动回滚**；如需回退 schema，请人工评估并备份后操作。
- 评测镜像也按 Release tag 发布，回滚时需要把 `judge_images` 白名单指向旧 tag（若使用 `all_versions` 则无需改白名单，只需题目/系统设置中的镜像 tag 指向旧版本）。

如果新版本已经执行了不兼容的数据库迁移，不能只切换应用镜像；必须停止服务、确认备份
可恢复后，按备份恢复流程处理数据，再启动上一版本。

## 8. 备份提示

### 8.1 初始化口令与创建快照

备份口令只保存在仓库外的受限文件中，不要写入 `noj-deploy.json` / `noj-secrets.json`
或提交到 Git：

```bash
sudo install -d -m 700 /etc/noj
openssl rand -hex 32 | sudo tee /etc/noj/backup-passphrase >/dev/null
sudo chmod 600 /etc/noj/backup-passphrase

export NOJ_BACKUP_PASSPHRASE_FILE=/etc/noj/backup-passphrase
noj-cli maintain backup create --dir /opt/neuro-oj --backup-dir /srv/noj/backups
```

每次快照都会生成 SHA-256 清单、PostgreSQL dump 结构清单、迁移状态和 `SUCCESS`
标记；默认保留 30 天，默认要求备份目录至少有 1GiB 可用空间。可通过
`NOJ_BACKUP_RETENTION_DAYS` 和 `NOJ_BACKUP_MIN_FREE_MB` 调整。

### 8.2 校验、恢复与恢复演练

```bash
snapshot=/srv/noj/backups/snapshot-YYYYMMDD-HHMMSS
noj-cli maintain backup verify "$snapshot" --dir /opt/neuro-oj
noj-cli maintain backup drill "$snapshot" --dir /opt/neuro-oj --report /srv/noj/restore-drill.txt
```

`drill` 不会触碰当前生产数据，只验证解密、校验和、PostgreSQL 结构、Redis RDB
以及对象镜像。周期性演练应在隔离部署目录中执行实际恢复：

```bash
noj-cli maintain backup restore "$snapshot" --dir /opt/neuro-oj --confirm
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
- 建议由 systemd timer、cron 或外部调度平台执行
  `noj-cli maintain backup create`，并对非零退出码、磁盘空间不足、`verify`
  失败和恢复演练失败发送告警。备份目录应同步到与生产主机不同故障域的加密存储。

密钥轮换和失效步骤见[生产密钥轮换 Runbook](./production-secrets.md)。
