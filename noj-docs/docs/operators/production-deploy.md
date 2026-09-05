# 生产部署（公测）

本文档介绍 Linux 服务器上的一键部署方式。生产服务使用 Docker Compose 和
`ghcr.io/neuro-oj/` 镜像；`noj-cli` 负责生产安装与运维，复用 `.env.prod` 和现有生产 Compose。
JSON 配置下的 `deploy/maintain` 命令独立保留，不会自动转换现有生产数据。

生产环境默认将容器日志限制为每个文件 50 MiB、保留 5 个文件；如需集中检索，应在宿主机或日志平台配置采集器，并避免写入凭据、代码、prompt 或完整提交内容。

## 1. 前置条件

- Linux amd64 服务器，至少 2 vCPU、2 GiB Swap 和 5 GiB 可用磁盘空间。
- Docker Engine 和 Docker Compose v2，当前用户可以运行 Docker。
- `curl` 或 `wget`、`tar`、`openssl`、CA 证书。
- 能够访问 GitHub 源码地址和 `ghcr.io/neuro-oj/` 镜像；网络受限时请先配置 Docker 镜像源或代理。
- 正式网站建议准备域名和 HTTPS 证书；临时测试可使用服务器 IP 和 HTTP。

### 宝塔等服务器面板

安装脚本会自动识别宝塔面板，只给出反向代理提示，不调用面板 API，也不会修改已有站点、证书
或其他容器。部署完成后，在面板中把域名反向代理到 `127.0.0.1:8080`；如修改了
`NGINX_PORT`，请使用修改后的端口。启用 Judge 时仍必须使用独立的 rootless Docker socket，
不能填写 `/run/docker.sock` 或 `/var/run/docker.sock`。

## 2. 一键安装

直接复制以下命令到服务器控制台：

```bash
curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh | \
  bash -s -- --dir /opt/neuro-oj
```

脚本会按以下顺序执行：

1. 检查 Linux、CPU 架构、Docker、Compose、磁盘和端口。
2. 下载指定版本的部署文件和 `noj-cli-linux-amd64`，SHA-256 校验通过后安装到 `bin/noj-cli`；未指定版本时自动选择最新 Release。
   所选 Release 必须包含 CLI 资产，下载或校验失败不会覆盖已有安装。生产机无需 Deno。
3. 首次创建 `.env.prod`，用简单提示询问网站地址、HTTP/HTTPS、邮件服务和是否安装 Judge。
4. `noj-cli install` 引导用户确认配置后，拉取镜像、执行数据库迁移并等待健康检查，完成后注册 PATH 命令。

可选参数：

```bash
# 固定版本：将 vX.Y.Z 替换为包含 CLI 资产的 Release 标签
curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh | \
  bash -s -- --ref vX.Y.Z --dir /opt/neuro-oj

# 只检查环境，不下载源码
curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh | \
  bash -s -- check

# 只安装基础工具；Docker Engine 仍需按发行版方式安装
curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh | \
  bash -s -- install-env
```

重复执行时，如果目标目录已经是 NOJ 安装目录，脚本会保留 `.env.prod`、备份和数据卷并继续执行；
不会因为目录非空而停止。其他非空目录只更新 NOJ 部署文件，保留其余内容。若之前配置过，脚本开头会询问是否继续使用；
选择重新填写时只在最后确认后写入正式配置。

安装完成后打开网站注册第一个用户，该用户自动成为管理员，不需要填写管理员邮箱或密码。
邮件服务可以选择“暂不配置”，不影响网站启动，但密码找回邮件不可用。Judge 可以在安装时跳过，
之后补充独立 Docker socket 后再启用。

## 2.1 版本发布流程（维护者）

为避免"Release 已可见但镜像 / CLI 资产尚未就绪"的窗口（issue #431），发布采用
预发布转正流程：

1. 创建 GitHub Release 并勾选 **pre-release**（tag 形如 `vX.Y.Z` 或 `X.Y.Z-rc.N`）。
2. `release.yml` 监听 `published` / `prereleased` 事件（只处理预发布 Release）：构建 7 个候选镜像 → 漏洞扫描 → 签名 / SBOM /
   来源证明 → 验证 digest 与 smoke test → 上传同版本 `noj-cli` 二进制与校验文件。
3. 全部通过后，工作流最后的 `publish-release` 任务把预发布转正为正式 Release（`--latest`）。

由此保证：`/releases/latest` 指向的版本一定具备同版本镜像、CLI 资产与校验文件。
安装器（`scripts/deploy/install.sh`）自动选择版本时同样只接受非 draft、非 prerelease
且资产中包含 `noj-cli-linux-amd64` 与 `.sha256` 的 Release，双重过滤未就绪版本。
直接发布正式 Release（published）会被工作流识别并跳过构建；重试时正式镜像 tag 指向不同构建
会被拒绝覆盖，避免版本混用。

## 3. 配置说明

配置文件位于 `/opt/neuro-oj/.env.prod`，权限应为 `600`。常用配置如下：

| 配置项 | 说明 |
|---|---|
| `NOJ_VERSION` | 要使用的 Release 标签，例如 `v0.8.1`；不要填写 `latest` |
| `DOMAIN` | 网站地址，只填写域名或服务器 IP，不要写 `http://`/`https://` |
| `APP_URL` | 网站完整地址，例如 `http://1.2.3.4` 或 `https://oj.example.com` |
| `CORS_ALLOWED_ORIGINS` | 通常与 `APP_URL` 相同 |
| `POSTGRES_PASSWORD` / `REDIS_PASSWORD` | 数据库和 Redis 强密码 |
| `JWT_SECRET` / `TFA_ENCRYPTION_KEY` | 至少 32 个字符的随机密钥 |
| `EMAIL_PROVIDER` | `aliyun`、`tencent` 或 `disabled`；可直接跳过 |
| `JUDGE_ENABLED` | 是否启动 Judge，默认 `true` |
| `JUDGE_DOCKER_SOCKET` | Judge 专用 rootless Docker socket；禁止使用宿主机默认 socket |
| `NGINX_PORT` | 对外端口，默认 `8080` |
| `NOJ_ENFORCE_IMAGE_SIGNATURES` | 默认 `false`；只有主动开启时才需要 Cosign |

容器内 Nginx 只处理 HTTP。使用 HTTPS 时，应在宝塔、宿主机 Nginx、Caddy 或云负载均衡中终止 TLS，
再转发到 `127.0.0.1:8080`。脚本不会自动申请或安装证书。

## 4. 日常运维

安装目录默认为 `/opt/neuro-oj`，可以直接执行：

```bash
noj-cli check                 # 检查部署环境
noj-cli status                # 查看服务状态
noj-cli logs core             # 查看 core 日志
noj-cli logs judge --follow   # 持续查看 Judge 日志
noj-cli start                 # 启动服务
noj-cli stop                  # 停止服务但保留数据
noj-cli restart               # 重启服务
noj-cli backup                # 创建备份
noj-cli verify                # 校验配置和镜像
noj-cli config check          # 只检查配置，不改变服务
```

如果 `noj-cli` 尚未加入 PATH，也可以在安装目录执行 `./bin/noj-cli`，或直接调用：

```bash
cd /opt/neuro-oj
bash scripts/deploy/deploy.sh status
```

## 5. 升级与回滚

固定版本升级：

```bash
cd /opt/neuro-oj
# 将 vX.Y.Z 替换为包含 CLI 资产的目标版本
sed -i 's/^NOJ_VERSION=.*/NOJ_VERSION=vX.Y.Z/' .env.prod
noj-cli update
```

自动升级到最新稳定 Release：

```bash
noj-cli update --latest
```

升级前会创建并校验备份，拉取镜像，执行数据库迁移并等待健康检查；不会删除数据卷。若失败，
先查看 `noj-cli status` 和 `noj-cli logs`，再把 `NOJ_VERSION` 改回上一个已验证版本并执行 `noj-cli update`。
数据库迁移只追加，不会自动回滚，因此跨大版本升级前必须确认迁移兼容性。
注意：切回镜像标签不是数据库回滚；迁移只增不减，回退版本前需按迁移清单人工评估。

## 5.1 备份、文件校验与隔离恢复演练

备份体系分三层，必须区分能力边界：

| 层级 | 命令 | 证明的内容 |
|---|---|---|
| 备份 | `noj-cli backup`（`backup.sh create`） | PostgreSQL/Redis/MinIO/加密环境文件已写入快照 |
| 文件校验 | `noj-cli backup verify` / `backup drill` | 快照完整、口令可用、dump 结构可解析 |
| 隔离恢复演练 | `scripts/deploy/restore-drill.sh <快照>` | 业务真的可以从快照恢复并运行 |

`backup drill` 只做文件级校验，**不能**证明业务可恢复。真实的恢复验收演练：

```bash
cd /opt/neuro-oj
bash scripts/deploy/restore-drill.sh backups/snapshot-YYYYMMDD-HHMMSS \
  --passphrase-file /secure/noj-backup-passphrase
```

演练会把快照恢复到独立 Compose 项目（独立数据卷、独立子网、不映射宿主机端口、不接触生产卷），
随后通过真实 API 验收：管理员登录、题目读取、附件（支持包）下载与一次真实双容器评测
（需要 judge 沙箱 Docker socket 与 `noj-evaluator-python` / `noj-solution-python` 镜像，
与生产 judge 使用同一个独立 rootless daemon）。可用 `--skip-judge` 跳过评测环节。

演练报告（默认写入 `backups/snapshot-*/restore-drill-report.txt`）记录：快照时间、恢复耗时、
数据核对结果（迁移版本/用户数/Redis 键数/对象数）、业务验收明细，以及 RPO/RTO 目标与是否达标
（默认 RPO ≤ 24 小时、RTO ≤ 60 分钟，可用 `--rpo-max-hours` / `--rto-max-minutes` 调整）。
损坏快照、解密失败、数据库恢复失败或业务验收失败都会以非零退出并保留失败现场报告。
演练结束后自动 `down -v` 回收资源；`--keep` 可保留现场供人工检查。

建议每季度以及在重要迁移前各执行一次隔离恢复演练。备份快照与 GPG 解密口令文件必须异地独立保存；
口令丢失时快照无法恢复，任何演练都无法弥补。

## 6. 卸载

```bash
# 删除容器、网络和本地镜像，保留配置和数据卷
noj-cli uninstall

# 明确删除全部数据和安装目录（不可恢复）
noj-cli uninstall --all --yes
```

普通卸载要求输入 `UNINSTALL`，不会删除 PostgreSQL、Redis、MinIO、Judge 缓存、备份或配置。
完全删除要求输入 `DELETE ALL` 或使用 `--yes`，执行前请确认备份已保存到其他位置。

## 7. CLI 配置模式与源码运行

`noj-cli install/start/stop/status/update/uninstall/logs/backup/verify/config check` 管理 `.env.prod` 生产部署；
内部复用 `scripts/deploy/production.sh`、`deploy.sh` 和 `backup.sh`，因此旧配置、服务名和数据卷不变。
`noj-cli backup restore <快照> --confirm` 要求目标 Compose 服务已停止；`backup verify` 与 `backup drill` 用于校验和演练。

`deploy/maintain/run-server` 使用另一套 `noj-deploy.json` / `noj-secrets.json`，不能直接管理 `.env.prod` 安装。
若同时管理多个安装，请显式使用 `--dir` 选择目标。

开发者可从源码运行相同入口：

```bash
cd noj-cli
deno run -A src/cli.ts status --dir /opt/neuro-oj
deno task test
deno task test:production
```

Release workflow 在生产镜像验证通过后，编译并发布 Linux amd64 CLI 及 SHA-256 校验文件。
旧 Release 没有这些资产时不能使用新安装器安装；需要使用包含 CLI 的新 Release 或该旧版本自身的安装器。
