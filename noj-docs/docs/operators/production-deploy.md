# 生产部署（公测）

本文档介绍 Linux 服务器上的生产部署方式。生产服务使用 Docker Compose 和
`ghcr.io/neuro-oj/` 镜像；`noj-cli`（纯 TS）负责生产安装与运维，配置真相源唯一：
`.env.prod` + `docker-compose.prod.yml`。

> 早期版本的 JSON 编排模式（`noj-deploy.json` + `noj-secrets.json`）与
> `deploy`/`maintain`/`stack`/`run-server`/`doctor` 命令已全部移除。

生产环境默认将容器日志限制为每个文件 50 MiB、保留 5 个文件；如需集中检索，应在宿主机或日志平台配置采集器，并避免写入凭据、代码、prompt 或完整提交内容。

::: tip 阅读顺序
1. 先看下文「1. 前置条件」确认主机满足要求；
2. 照「2. 安装」下载并运行 `noj-cli install`；
3. 用「4. 日常运维」里的命令管理服务；
4. 需要升级/回滚/备份时看「5. 升级与回滚」及「5.1 备份、文件校验与隔离恢复演练」。
:::

## 1. 前置条件

- Linux amd64 服务器：仅启动/诊断至少 2 vCPU、2 GiB 内存、2 GiB Swap、目标磁盘 10 GiB 可用；这不是公测容量承诺。
- 启用同机 Judge 做低并发公测，起始建议至少 4 vCPU、8 GiB 内存、4 GiB Swap、目标磁盘 40 GiB 可用，最终规模必须按[容量基线](./capacity-baseline.md)实测确认。
- Docker Engine 和 Docker Compose v2，当前用户可以运行 Docker。
- `curl` 或 `wget`、`tar`、`openssl`、CA 证书。
- **glibc 系统**（Debian / Ubuntu / RHEL / CentOS 等）：`noj-cli` 二进制动态链接
  glibc，**Alpine 等 musl 发行版不能运行**（实测报 `not found`）。
- 能够访问 GitHub 源码地址和 `ghcr.io/neuro-oj/` 镜像；网络受限时请先配置 Docker 镜像源或代理。
- 正式网站建议准备域名和 HTTPS 证书；临时测试可使用服务器 IP 和 HTTP。

### 宝塔等服务器面板

安装脚本会自动识别宝塔面板，只给出反向代理提示，不调用面板 API，也不会修改已有站点、证书
或其他容器。部署完成后，在面板中把域名反向代理到 `127.0.0.1:8080`；如修改了
`NGINX_PORT`，请使用修改后的端口。启用 Judge 时仍必须使用独立的 rootless Docker socket，
不能填写 `/run/docker.sock` 或 `/var/run/docker.sock`。

## 2. 安装

**不再有自举脚本**：`setup.sh` 与 `scripts/deploy/install.sh` 已移除——安装职责
转入 `noj-cli` 自身，因此生产主机**无需 Deno**，也不需要下载源码。

从 Release 手动下载二进制并校验：

```bash
VERSION=v0.9.5   # 替换为目标 Release 标签
curl -fsSLO "https://github.com/Neuro-OJ/neuro-oj/releases/download/$VERSION/noj-cli-linux-amd64"
curl -fsSLO "https://github.com/Neuro-OJ/neuro-oj/releases/download/$VERSION/noj-cli-linux-amd64.sha256"
sha256sum -c noj-cli-linux-amd64.sha256
chmod +x noj-cli-linux-amd64
```

然后安装到目标目录（**目录可以是空的**：`install` 自己补齐部署文件）：

```bash
./noj-cli-linux-amd64 install --dir /opt/neuro-oj
```

::: warning 非交互环境必须先备好配置
`install` 在**没有 TTY**（如 CI、远程管道）或显式 `--non-interactive` 时不会进入
配置向导；此时若目录中没有现成的 `.env.prod`，安装会**报错且零写入**。
需要无人值守部署时，先手工准备好 `.env.prod`（权限 `600`，含全部必填值）再运行。
:::

`install` 会按以下顺序执行：

1. 从同版本 Release 下载 `docker-compose.prod.yml` 与 `.env.prod.example`，
   并校验 **SHA-256**（校验失败拒绝写入）；
2. 首次安装时由模板生成 `.env.prod`（权限 `600`），并写入自动生成的强随机密钥
   （`JWT_SECRET` / `TFA_ENCRYPTION_KEY` / 数据库与 Redis 口令 / S3 / LLM 主密钥等）；
   已存在则**逐字节保留**，不做覆盖；
3. 在 TTY 下进入配置向导（网站地址、HTTP/HTTPS、邮件服务、是否启用 Judge）。
   非交互环境必须显式提供配置，否则**报错且零写入**；
4. 解析备份口令（`--passphrase-file` / 环境变量 / `.env.prod` 三选一）；
5. 校验生产配置（env 文件 / 权限 / 必填值 / Judge socket / 端口 / Compose 解析）；
6. 校验镜像签名（仅在 `NOJ_ENFORCE_IMAGE_SIGNATURES` 开启时）；
7. 拉取镜像 → 等待健康检查 → 记录部署元数据 → 安装 `<dir>/bin/noj-cli` →
   注册 PATH 命令。

> **资产前置**：所选 Release 必须同时包含 CLI 二进制、校验文件与两个部署文件。
> 缺少任一资产时**明确报错**，不会混用不同版本（issue #431 的过滤规则）。

重复执行 `install` 时，若目标目录已是 NOJ 安装目录，会保留 `.env.prod`、备份与数据卷；
若 `.env.prod` 权限不是 `600`/`400`，安装会**在任何写入之前拒绝**。

### 环境检查

安装前可用 `check` 做只读校验（不修改任何东西）：

```bash
./noj-cli-linux-amd64 check --dir /opt/neuro-oj   # 需要目录已有 .env.prod
```

Docker Engine 仍需按发行版官方方式安装；`noj-cli` **不安装、不替换、不配置**宿主
Docker daemon（这是有意的边界：自动安装 daemon 需要 root 安装器，而那正是评测隔离
要防的东西）。

## 2.1 版本发布流程（维护者）

为避免"Release 已可见但镜像 / CLI 资产尚未就绪"的窗口（issue #431），发布采用
预发布转正流程：

1. 创建 GitHub Release 并勾选 **pre-release**（tag 形如 `vX.Y.Z` 或 `X.Y.Z-rc.N`）。
2. `release.yml` 监听 `published` / `prereleased` 事件（只处理预发布 Release）：构建 7 个候选镜像 → 漏洞扫描 → 签名 / SBOM /
   来源证明 → 验证 digest 与 smoke test → 上传同版本 `noj-cli` 二进制与校验文件。
3. 全部通过后，工作流最后的 `publish-release` 任务把预发布转正为正式 Release（`--latest`）。

由此保证：`/releases/latest` 指向的版本一定具备同版本镜像、CLI 资产与校验文件。
`noj-cli update --latest` 自动选择版本时同样只接受非 draft、非 prerelease 且资产中
包含 `noj-cli-linux-amd64`、`.sha256` 与两个部署文件的 Release，双重过滤未就绪版本。
直接发布正式 Release（published）会被工作流识别并跳过构建；重试时正式镜像 tag 指向不同构建
会被拒绝覆盖，避免版本混用。

## 3. 配置说明

配置文件位于 `/opt/neuro-oj/.env.prod`，权限应为 `600`。常用配置如下：

| 配置项 | 说明 |
|---|---|
| `NOJ_VERSION` | 要使用的 Release 标签，例如 `v0.9.5`；不要填写 `latest` |
| `DOMAIN` | 对外域名或服务器 IP，只填主机名，不要写 `http://`/`https://`（`install` 的向导会据此生成 `APP_URL`；不直接注入容器） |
| `APP_URL` | 网站完整地址，例如 `http://1.2.3.4` 或 `https://oj.example.com` |
| `CORS_ALLOWED_ORIGINS` | 通常与 `APP_URL` 相同 |
| `POSTGRES_PASSWORD` / `REDIS_PASSWORD` | 数据库和 Redis 强密码 |
| `JWT_SECRET` / `TFA_ENCRYPTION_KEY` | 至少 32 个字符的随机密钥 |
| `EMAIL_PROVIDER` | `aliyun`、`tencent` 或 `disabled`；`disabled` 时邮箱验证/密码找回不可用，公开注册被禁止（见[后台管理指南](./admin-guide.md)） |
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
noj-cli backup create         # 创建备份快照（backup 必须带子命令）
noj-cli backup list           # 列出已有备份
noj-cli verify                # 校验配置和镜像
noj-cli config check          # 只检查配置，不改变服务
```

::: tip `backup` 必须带子命令
`noj-cli backup` 本身不创建备份，只打印用法错误。创建用
`noj-cli backup create`，另有 `verify` / `list` / `prune` / `restore` / `drill` /
`schedule` 子命令。
:::

如果 `noj-cli` 尚未加入 PATH，可以直接调用安装目录内的二进制：

```bash
/opt/neuro-oj/bin/noj-cli status
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

`update --latest` 与安装器使用同一过滤规则（issue #431）：只选择非 draft、
非 prerelease 且资产中包含 `noj-cli-linux-amd64` 与 `.sha256` 的 Release，
保证安装与升级使用同一版本集合，不会选中资产未就绪的版本。

升级前会创建并校验备份，拉取镜像，执行数据库迁移并等待健康检查；不会删除数据卷。若失败，
先查看 `noj-cli status` 和 `noj-cli logs`，再把 `NOJ_VERSION` 改回上一个已验证版本并执行 `noj-cli update`。
数据库迁移只追加，不会自动回滚，因此跨大版本升级前必须确认迁移兼容性。
注意：切回镜像标签不是数据库回滚；迁移只增不减，回退版本前需按迁移清单人工评估。

### 升级前检查：题目引用的 LLM Provider 是否为用户自建

**适用版本**：升级到移除 BYOK 的版本（`llm_providers.created_by` 列被删除）时必查。

在删除 BYOK 的迁移中，gateway 会执行
`DELETE FROM llm_providers WHERE created_by <> '0'`（永久删除用户自建 Provider
及其加密 Key）。**历史上题目的 `problems.llm_config->>'provider_id'` 可以指向
用户自建 Provider**（题目保存时的校验只检查 Provider 存在且启用，不校验归属），
因此这类题目的引用会在升级后变成悬空：提交仍会被接受，但评测时 gateway 返回
400 `provider_not_found`，表现为"LLM 题评测静默失败"。

升级**之前**用下面的 SQL 核查（`psql` 连到生产库）：

```sql
-- 列出会被删除、但已被题目引用的用户 Provider
SELECT p.id AS problem_id, p.title, p.llm_config->>'provider_id' AS provider_id
FROM problems p
JOIN llm_providers lp ON lp.id = p.llm_config->>'provider_id'
WHERE lp.created_by <> '0';
```

::: warning 悬空 Provider 引用会导致 LLM 题静默失败
- **结果为空**：直接升级。
- **有结果**：先把这些题目的 LLM 配置改为平台 Provider（管理端编辑题目即可），
  或按需清空（`UPDATE problems SET llm_config = NULL WHERE id = '<problem_id>'`），
  再执行升级。升级后这类题目的**编辑保存**也会以
  「LLM Provider 不存在或已停用」失败，因此不要留到升级后再处理。
:::

> 升级后若怀疑存在遗漏，可再查一次悬空引用：
> `SELECT id, title FROM problems WHERE llm_config->>'provider_id' IS NOT NULL
> AND llm_config->>'provider_id' NOT IN (SELECT id FROM llm_providers);`

## 5.1 备份、文件校验与隔离恢复演练

备份体系分三层，必须区分能力边界：

| 层级 | 命令 | 证明的内容 |
|---|---|---|
| 备份 | `noj-cli backup create` | PostgreSQL/Redis/MinIO/加密环境文件已写入单个 `.nojbackup` |
| 文件校验 | `noj-cli backup verify` | 快照完整、口令可用、dump 结构可解析（`--deep` / `--payload-sha` 逐档加深） |
| 隔离恢复演练 | `noj-cli backup drill <快照>` | 业务真的可以从快照恢复并运行 |

`backup verify` 只做**文件级**校验，**不能**证明业务可恢复；`backup drill` 才是
真正的恢复验收演练（会起独立 Compose 项目，分钟级、需 Docker）：

```bash
# 快照是 .nojbackup 单文件，命名形如 snapshot-YYYYMMDD-HHMMSS.nojbackup
noj-cli backup drill backups/snapshot-20260924-021500.nojbackup \
  --passphrase-file /secure/noj-backup-passphrase
```

演练会把快照恢复到独立 Compose 项目（独立数据卷、独立子网、不映射宿主机端口、不接触生产卷），
随后通过真实 API 验收：管理员登录、题目读取、附件（支持包）下载与一次真实双容器评测
（需要 judge 沙箱 Docker socket 与 `noj-evaluator-python` / `noj-solution-python` 镜像，
与生产 judge 使用同一个独立 rootless daemon）。可用 `--skip-judge` 跳过评测环节。

演练报告（默认写入快照同级的 `restore-drill-report.txt`，权限 600）记录：快照时间、恢复耗时、
数据核对结果（迁移版本/用户数/Redis 键数/对象数）、业务验收明细，以及 RPO/RTO 目标与是否达标
（默认 RPO ≤ 24 小时、RTO ≤ 60 分钟，可用 `--rpo-max-hours` / `--rto-max-minutes` 调整）。
损坏快照、解密失败、数据库恢复失败或业务验收失败都会以非零退出并保留失败现场报告。
演练结束后自动 `down -v` 回收资源；`--keep` 可保留现场供人工检查。

::: danger 口令遗失 = 备份不可恢复
备份快照与 GPG 解密口令文件必须异地独立保存；口令丢失时快照无法恢复，
任何演练都无法弥补。建议每季度以及在重要迁移前各执行一次隔离恢复演练。
:::

### 5.2 定期备份调度与 RPO

恢复演练只能测量 RPO，不能替代定期创建快照。生产安装完成后，建议为当前安装用户注册每日备份任务：

```bash
cd /opt/neuro-oj
noj-cli backup schedule install \
  --schedule '15 2 * * *' \
  --passphrase-file /etc/noj/backup-passphrase
noj-cli backup schedule status
```

任务只维护自己标记的 crontab 区块，不覆盖其他任务；每次执行会保留快照并将输出写入
`backups/backup-cron.log`。默认每日 02:15 执行，实际时间按服务器时区计算。建议把备份目录和
口令文件放在独立磁盘/主机，并由监控检查 `noj_backup_last_success_unix_time`；任务失败时应立即
检查日志和磁盘空间。删除任务使用 `noj-cli backup schedule remove`。

每日快照将 RPO 控制在约 24 小时以内，但无法保证精确上限：任务失败、主机离线或异地复制延迟
都会扩大实际 RPO。正式验收仍须记录最近快照时间、RPO、RTO 以及备份是否异地保存。

## 6. 卸载

```bash
# 删除容器、网络和本地镜像，保留配置和数据卷
noj-cli uninstall

# 明确删除全部数据和安装目录（不可恢复）
noj-cli uninstall --all --yes
```

::: danger 不可逆：`uninstall --all`
完全删除会连同 PostgreSQL、Redis、MinIO 数据卷、备份与安装目录一并删除，
**无法恢复**。普通卸载（不带 `--all`）只删容器/网络/本地镜像，要求交互输入
`UNINSTALL`；完全删除要求输入 `DELETE ALL` 或使用 `--yes`。
执行前请务必确认备份已保存到其他位置。
:::

## 7. CLI 配置模式与源码运行

`noj-cli install/start/stop/status/update/uninstall/logs/backup/verify/config check` 管理 `.env.prod` 生产部署；
全部运维能力由 `noj-cli` 的 TS 实现直接完成（`src/prod/`），不再经任何 bash 脚本转发，
因此配置、服务名与数据卷与旧版本完全一致。
`noj-cli backup restore <快照> --confirm` 要求目标 Compose 服务已停止；`backup verify` 与 `backup drill` 用于校验和演练。

`deploy`/`maintain`/`stack`/`run-server` 与它们使用的 `noj-deploy.json` /
`noj-secrets.json` 已移除；`noj-cli` 只管理 `.env.prod` 安装。
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
