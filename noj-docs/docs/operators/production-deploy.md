# 生产部署（公测）

本文档介绍 Linux 服务器上的生产部署方式。生产服务使用 Docker Compose 和
`ghcr.io/neuro-oj/` 镜像；`noj-cli`（纯 TS）负责生产安装与运维，配置真相源唯一：
`.env.prod` + `docker-compose.prod.yml`。

> 早期版本的 JSON 编排模式（`noj-deploy.json` + `noj-secrets.json`）与
> `deploy`/`maintain`/`stack`/`run-server`/`doctor` 命令已全部移除。

生产环境默认将容器日志限制为每个文件 50 MiB、保留 5
个文件；如需集中检索，应在宿主机或日志平台配置采集器，并避免写入凭据、代码、prompt
或完整提交内容。

::: tip 阅读顺序

1. 先看下文「1. 前置条件」确认主机满足要求；
2. 照「2. 安装」下载并运行 `noj-cli install`；
3. 用「4. 日常运维」里的命令管理服务；
4. 需要升级/回滚/备份时看「5. 升级与回滚」及「5.1
   备份、文件校验与隔离恢复演练」。 :::

## 1. 前置条件

- Linux amd64 服务器：仅启动/诊断至少 2 vCPU、2 GiB 内存、2 GiB Swap、目标磁盘
  10 GiB 可用；这不是公测容量承诺。
- 启用同机 Judge 做低并发公测，起始建议至少 4 vCPU、8 GiB 内存、4 GiB
  Swap、目标磁盘 40 GiB
  可用，最终规模必须按[容量基线](./capacity-baseline.md)实测确认。
- Docker Engine 和 Docker Compose v2，当前用户可以运行 Docker。
- `curl` 或 `wget`、`tar`、`openssl`、CA 证书。
- **glibc 系统**（Debian / Ubuntu / RHEL / CentOS 等）：`noj-cli` 二进制动态链接
  glibc，**Alpine 等 musl 发行版不能运行**（实测报 `not found`）。
- 能够访问 GitHub 源码地址和 `ghcr.io/neuro-oj/` 镜像；网络受限时请先配置 Docker
  镜像源或代理。
- 正式网站建议准备域名和 HTTPS 证书；临时测试可使用服务器 IP 和 HTTP。

### 宝塔等服务器面板

安装脚本会自动识别宝塔面板，只给出反向代理提示，不调用面板
API，也不会修改已有站点、证书 或其他容器。部署完成后，在面板中把域名反向代理到
`127.0.0.1:8080`；如修改了 `NGINX_PORT`，请使用修改后的端口。启用 Judge
时仍必须使用独立的 rootless Docker socket， 不能填写 `/run/docker.sock` 或
`/var/run/docker.sock`。

## 2. 安装

**不再有自举脚本**：`setup.sh` 与 `scripts/deploy/install.sh` 已移除——安装职责
转入 `noj-cli` 自身，因此生产主机**无需 Deno**，也不需要下载源码。

从 Release 手动下载二进制并校验：

```bash
VERSION=v0.10.6   # 替换为目标 Release 标签
curl -fsSLO "https://github.com/Neuro-OJ/neuro-oj/releases/download/$VERSION/noj-cli-linux-amd64"
curl -fsSLO "https://github.com/Neuro-OJ/neuro-oj/releases/download/$VERSION/noj-cli-linux-amd64.sha256"
sha256sum -c noj-cli-linux-amd64.sha256
chmod +x noj-cli-linux-amd64
```

然后安装到目标目录（**目录可以是空的**：`install` 自己补齐部署文件）：

```bash
./noj-cli-linux-amd64 install --dir /opt/neuro-oj --ref "$VERSION"
```

::: warning 非交互环境必须先备好配置 `install` 在**没有 TTY**（如
CI、远程管道）或显式 `--non-interactive` 时不会进入
配置向导；此时若目录中没有现成的 `.env.prod`，安装会**报错且零写入**。
需要无人值守部署时，先手工准备好 `.env.prod`（权限 `600`，含全部必填值）再运行。
:::

`install` 会按以下顺序执行：

1. 从同版本 Release 下载 `docker-compose.prod.yml` 与 `.env.prod.example`，
   并校验 **SHA-256**（校验失败拒绝写入）；
2. 首次安装时由模板生成 `.env.prod`（权限 `600`），并写入自动生成的强随机密钥
   （`JWT_SECRET` / `TFA_ENCRYPTION_KEY` / 数据库与 Redis 口令 / S3 / LLM
   主密钥等）； 已存在则**逐字节保留**，不做覆盖；
3. 在 TTY 下进入配置向导（网站地址、HTTP/HTTPS、邮件服务、是否启用 Judge）。
   非交互环境必须显式提供配置，否则**报错且零写入**；
4. 解析备份口令（`--passphrase-file` / 环境变量 / `.env.prod` 三选一）；
5. 校验生产配置（env 文件 / 权限 / 必填值 / Judge socket / 端口 / Compose
   解析）；
6. 校验镜像签名（仅在 `NOJ_ENFORCE_IMAGE_SIGNATURES` 开启时）；
7. 拉取镜像 → 等待健康检查 → 记录部署元数据 → 安装 `<dir>/bin/noj-cli` → 注册
   PATH 命令。

> **资产前置**：所选 Release 必须同时包含 CLI 二进制、校验文件与两个部署文件。
> 缺少任一资产时**明确报错**，不会混用不同版本（issue #431 的过滤规则）。

重复执行 `install` 时，若目标目录已是 NOJ 安装目录，会保留
`.env.prod`、备份与数据卷； 若 `.env.prod` 权限不是
`600`/`400`，安装会**在任何写入之前拒绝**。

### 环境检查

安装前可用 `check` 做只读校验（不修改任何东西）：

```bash
./noj-cli-linux-amd64 check --dir /opt/neuro-oj   # 需要目录已有 .env.prod
```

Docker Engine 仍需按发行版官方方式安装；`noj-cli` **不安装、不替换、不配置**宿主
Docker daemon（这是有意的边界：自动安装 daemon 需要 root
安装器，而那正是评测隔离 要防的东西）。

## 2.1 版本发布流程（维护者）

为避免"Release 已可见但镜像 / CLI 资产尚未就绪"的窗口（issue #431），发布采用
预发布转正流程：

1. 创建 GitHub Release 并勾选 **pre-release**（tag 形如 `vX.Y.Z` 或
   `vX.Y.Z-rc.N`）。
2. `release.yml` 只监听 `prereleased` 事件（不监听
   `published`，避免同一次预发布触发两条流水线）：构建 7 个候选镜像 → 漏洞扫描 →
   签名 / SBOM / 来源证明 → 验证 digest 与 smoke test → 上传同版本 `noj-cli`
   二进制、`docker-compose.prod.yml`、`env.prod.example` 及各自的校验文件。
3. 全部通过后，工作流最后的 `publish-release` 任务把预发布转正为正式
   Release（`--latest`）。

由此保证：`/releases/latest` 指向的版本一定具备同版本镜像、CLI 资产与校验文件。
`noj-cli install`（省略 `--ref`）与 `update --latest` 自动选择版本时只接受非
draft、非 prerelease（即已转正，含 `-rc.N` 等标签）且资产中 包含
`noj-cli-linux-amd64`、`.sha256` 与两个部署文件的 Release，双重过滤未就绪版本。
直接发布正式 Release（不经预发布）不会触发构建；重试时正式镜像 tag 指向不同构建
会被拒绝覆盖，避免版本混用。

## 3. 配置说明

配置文件位于 `/opt/neuro-oj/.env.prod`，权限应为 `600`。常用配置如下：

| 配置项                                 | 说明                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `NOJ_VERSION`                          | 要使用的 Release 标签，例如 `v0.10.6`；不要填写 `latest`                                                                      |
| `DOMAIN`                               | 对外域名或服务器 IP，只填主机名，不要写 `http://`/`https://`（`install` 的向导会据此生成 `APP_URL`；不直接注入容器）          |
| `APP_URL`                              | 网站完整地址，例如 `http://1.2.3.4` 或 `https://oj.example.com`                                                               |
| `CORS_ALLOWED_ORIGINS`                 | 通常与 `APP_URL` 相同                                                                                                         |
| `POSTGRES_PASSWORD` / `REDIS_PASSWORD` | 数据库和 Redis 强密码                                                                                                         |
| `JWT_SECRET` / `TFA_ENCRYPTION_KEY`    | 至少 32 个字符的随机密钥                                                                                                      |
| `EMAIL_PROVIDER`                       | `aliyun`、`tencent` 或 `disabled`；`disabled` 时邮箱验证/密码找回不可用，公开注册被禁止（见[后台管理指南](./admin-guide.md)） |
| `JUDGE_ENABLED`                        | 是否启动 Judge，默认 `true`                                                                                                   |
| `JUDGE_DOCKER_SOCKET`                  | Judge 专用 rootless Docker socket；禁止使用宿主机默认 socket                                                                  |
| `NGINX_PORT`                           | 对外端口，默认 `8080`                                                                                                         |
| `NOJ_ENFORCE_IMAGE_SIGNATURES`         | 默认 `false`；只有主动开启时才需要 Cosign                                                                                     |

容器内 Nginx 只处理 HTTP。使用 HTTPS 时，应在宝塔、宿主机 Nginx、Caddy
或云负载均衡中终止 TLS， 再转发到 `127.0.0.1:8080`。脚本不会自动申请或安装证书。

### 3.1 沙箱镜像签名与专网赛事环境配置（SC-02）

在生产与赛事环境中，沙箱镜像（`noj-evaluator-python`、`noj-solution-python`
等）的完整性校验分为两种典型模式：

1. **公网/联网高安全环境（强启 Cosign 验签）**：
   - 将 `NOJ_ENFORCE_IMAGE_SIGNATURES=true` 写入 `.env.prod`。
   - 配置 `NOJ_COSIGN_CERTIFICATE_IDENTITY_REGEXP`（如
     `^https://github\.com/xyber-nova/neuro-oj/\.github/workflows/release\.yml@refs/tags/v.*$`）与
     `NOJ_COSIGN_CERTIFICATE_OIDC_ISSUER=https://token.actions.githubusercontent.com`。
   - `noj-cli verify` 将调用 `cosign verify` 强校验 GitHub Actions 无密钥 OIDC
     签名。

2. **离线/专网现场赛事环境（无法连接公网 OIDC 服务）**：
   - 维持默认 `NOJ_ENFORCE_IMAGE_SIGNATURES=false`。
   - **离线安全操作规范**：
     - 在有网络的构建机上拉取官方 Release 镜像并校验 digest，执行 `docker save`
       导出 `.tar`；
     - 连同 Release 页面公布的 SHA-256
       校验和文件，通过受信任介质拷贝至专网服务器；
     - 校验介质文件 SHA-256 后，在专网服务器执行 `docker load -i <image.tar>`
       灌装到 Judge 专属 Rootless Docker Daemon 中；
     - 检查 `docker images --digests` 确认与官方发布的 digest
       一致，防止赛事期间未授权镜像篡改。

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

::: tip `backup` 必须带子命令 `noj-cli backup`
本身不创建备份，只打印用法错误。创建用 `noj-cli backup create`，另有 `verify` /
`list` / `prune` / `restore` / `drill` / `schedule` 子命令。 :::

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

自动升级到最新正式 Release：

```bash
noj-cli update --latest
```

`update --latest` 与安装器使用同一过滤规则（issue #431）：只选择非 draft、 非
prerelease 且资产中包含 `noj-cli-linux-amd64`、两个部署文件及各自 `.sha256` 的
Release， 保证安装与升级使用同一版本集合，不会选中资产未就绪的版本。

升级前会创建并校验备份，拉取镜像，执行数据库迁移并等待健康检查；不会删除数据卷。若失败，
先查看 `noj-cli status` 和 `noj-cli logs`，再把 `NOJ_VERSION`
改回上一个已验证版本并执行 `noj-cli update`。
数据库迁移只追加，不会自动回滚，因此跨大版本升级前必须确认迁移兼容性。
注意：切回镜像标签不是数据库回滚；迁移只增不减，回退版本前需按迁移清单人工评估。

### 0.11 首个 RC：只支持新装，不做原地升级

0.11 的首个 RC（`v0.11.0-rc.N`）**只交付新装路径**。它把 Domain 变成资源访问边界、
把比赛改为统一报名、把通知合并成单一模型——这些都是数据形态迁移，而历史数据的
转换工具不在本轮范围。

因此：

- **新装**：用同一 Release 的 `noj-cli`、core、gateway、judge、UI 与适配的 IDE
  组件，从**空库**安装。全新安装走的是完整迁移链，空库里没有旧数据，因此不会命中
  `0116` 的数据守卫。
- **已有 0.10.x 实例**：继续运行原版本，**不要**执行 0.11 的 `noj-cli update`。
  0.10.x → 0.11 的升级能力另行设计并单独验收，完成前不提供该路径。
- **不要**为了"让它过"而删除比赛、删除题目或绕过迁移守卫。`0116` 的中止是刻意的
  数据契约，不是待修的缺陷。

#### 升级前的只读预检

迁移 `0116_peaceful_gorilla_man.sql` 开头是兼容性守卫：存量库只要还有旧 `U` 型题
或任意一行 `contests`，迁移就会以 `55000` 中止。想在动手前知道命中了什么，先跑预检：

```bash
cd /opt/neuro-oj/noj-core      # 源码树中即 noj-core/
deno run --env-file=.env -A scripts/preflight-upgrade.ts \
  --json /tmp/noj-preflight.json --csv /tmp/noj-preflight.csv
```

或在 `noj-core` 目录用任务别名：

```bash
deno task preflight -- --json /tmp/noj-preflight.json
```

预检的所有查询都在一个 `SET TRANSACTION READ ONLY` 事务里执行，**不写任何业务
数据**。报告包含迁移位置、旧 `U` 型题与比赛的数量及标识、相关依赖计数和遗留列
提示。退出码：`0` 未命中阻塞、`2` 命中阻塞（迁移会中止）、`1` 预检本身失败。

> **预检报告不是备份。** 它只用于决策，不能替代 `noj-cli backup create`、
> `noj-cli backup verify` 与 `noj-cli backup drill`。

#### 新装 runbook

1. 准备主机与 `.env.prod`（`docker-compose.prod.yml` 与 `.env.prod.example` 必须
   与 Release 同版本），生成 `NOJ_INTERNAL_SERVICE_TOKEN`（见下文
   [新增环境变量](#011-新增环境变量)）；
2. 用 Release 的 CLI 安装：`noj-cli install --dir <目录> --ref v0.11.0-rc.N`，
   安装器会下载并校验同名部署文件及其 `.sha256`；
3. `noj-cli check` → `noj-cli start`，等待健康检查通过；
4. `noj-cli bootstrap first-admin` 创建首个管理员（仅空站可执行一次）；
5. 冒烟：注册 / 登录、题目读取、一次真实 Judge 提交、一次客观题交卷、一次比赛报名；
6. 新装失败时**停止候选服务并保留诊断资料**（`noj-cli logs`、容器状态、迁移日志），
   不要在有数据的库上反复重试迁移。

### 0.11 新增环境变量

| 变量 | 默认值 | 配置位置 | 说明 |
| --- | --- | --- | --- |
| `NOJ_INTERNAL_SERVICE_TOKEN` | 空（关闭） | `.env.prod` | 内部维护 / 排空 API 的服务凭据（`Authorization: Bearer <token>`）。`openssl rand -hex 32` 生成。**未设置时所有 drain 端点返回 503**，`noj-cli update` 的自动排空会失败并提示设置本变量；过渡期可显式 `--skip-drain` 跳过。首次从尚无该 API 的旧版本升级时，`update` 会识别 `endpoint_unavailable` 并自动跳过。 |
| `NUXT_PUBLIC_AUTH_COOKIE_PREFIX` | `noj` | `.env.prod` / compose | 身份 Cookie 前缀。同一主机不同端口运行多套 UI 时分别设置，避免登录 Cookie 互相覆盖。 |
| `NUXT_BFF_CACHE_PREFIX` | `noj:ui:bff:v1` | `.env.prod` / compose | UI BFF 聚合缓存的 Redis 命名空间（TTL 30 秒，复用现有 Redis）。多套 UI 共用同一 Redis 时必须区分。 |

三者都由 `docker-compose.prod.yml` 插值传入容器；修改后需要重建受影响的容器
（`noj-cli restart`）。`check-prod-env-injection.ts` 会校验它们在被声明与实际注入
之间没有断链。

### 题目版本管理升级（协调升级，必须按维护窗口执行）

题目版本管理（草稿/发布、不可变版本、评测尝试、有效版本策略）是 **core / judge /
gateway / UI / IDE / CLI 的协调升级**，新旧评测协议**不能混跑**：新 core 只接受
`evaluation_protocol_version = 3` 的结果，旧 judge
的结果会被拒绝落库（不会写坏数据， 但提交会一直拿不到成绩）。因此：

1. 确认 CI、迁移演练与完整验收通过（含 `noj-core` 迁移安全、`noj-tests` E2E）；
2. 进入维护窗口：停止新提交与题目编辑（可临时把站点切到维护公告）；
3. 排空 Judge 队列与活动评测（`noj-cli status` / Redis 队列为空）；
4. 备份数据库与对象存储（`noj-cli backup create`，并 `backup verify`）；
5. 同步升级全部服务到同一版本（`noj-cli update` 会拉齐 core/judge/gateway/ui
   镜像）；
6. 核对迁移结果：
   - 迁移数应为最新（`drizzle.__drizzle_migrations`）；
   - 每道题都有 `problem_versions` 基线且 `problems.latest_version_id` 非空；
   - 迁移前的历史成绩已转成 `legacy_import` 尝试 + 未知版本当前判定；
   - `contest_problems.pinned_version_id` 全非空；`submission_version_results`
     与提交数合理；
7. 重建搜索索引并核对：`scripts/noj.ts search reindex`（只索引已发布题目）；
8. 全题型冒烟 + 正式成绩读取验证（题库详情/竞赛榜/个人主页/提交详情各取一条）；
9. 恢复访问。

**回滚**：只能使用升级前备份 + 同版本服务组合（`noj-cli backup restore` 或
`backup drill` 验证过的快照）。**不能**只回退 core 二进制去读新
schema——迁移只追加 （`0105` 删 `evaluation_results`、`0107` 删
`objective_questions`），旧版本代码会引用 已删除的表。

> 迁移链（本次发布）：`0102` 建表 → `0103` 基线 V1 + 既有结果转尝试 → `0104`
> 重建 `user_rankings` 视图 → `0105` 删 `evaluation_results` → `0106`
> 竞赛固定版本回填 + `NOT NULL` → `0107` 删 `objective_questions`。`0106`
> 对"被竞赛引用但未发布版本"的题目 会先补 `migration_baseline` V1
> 再回填；仍有空值时迁移**直接报错中止**（宁可不升级，
> 也不写入空的固定版本），此时请先为相关题目发布版本后重跑。

### 确认线上正在运行哪个构建

四个口径互为参照，任一即可确认"当前跑的是哪个版本、哪次提交"：

| 口径       | 位置                                                                                   | 说明                                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 站点页脚   | 页脚品牌列「前端 / 后端」两行                                                          | `前端` = noj-ui 构建身份（编译进产物），`后端` = noj-core 运行身份（来自镜像 ENV）。各含版本号、commit、构建时间；时间按访问者本地时区显示，悬停可见完整 SHA 与原始 ISO 时间 |
| 健康探针   | `GET /healthz`（nginx 公开代理到 core `/health/ready`）                                | 响应里的 `version` 与页脚「后端」一致                                                                                                                                        |
| 站点元信息 | `GET /api/v1/site/meta` → `data.build`                                                 | `{version, commit, builtAt}`，页脚「后端」即取此值                                                                                                                           |
| 镜像元数据 | `docker inspect <image>` 输出的 `Config.Labels` 中 `org.opencontainers.image.revision` | Release 流水线写入的完整 commit，与前三者应一致                                                                                                                              |

三个构建身份变量由 Release 流水线以 build-arg 注入，**不需要**写进 `.env.prod`：

| 变量                | 含义                            |
| ------------------- | ------------------------------- |
| `NOJ_BUILD_VERSION` | Release 标签（如 `v0.10.6`）    |
| `NOJ_BUILD_COMMIT`  | 完整 commit SHA（`github.sha`） |
| `NOJ_BUILD_TIME`    | 构建时刻（UTC，ISO 8601）       |

本地源码运行时三者缺省回退：版本取模块清单（`deno.json` /
`package.json`）、commit 取本地 git 短 SHA（工作区有改动则缀
`-dirty`）、构建时间取进程启动时刻——因此本地页脚显示的 `-dirty`
是正常现象，表示图像来自未提交的工作区。

### LLM 配置迁移：历史 BYOK 与当前域配置 {#升级前检查题目引用的-llm-provider-是否为用户自建}

当前版本按**使用域**选择 Provider 和模型。已有平台 Provider、用量及默认配置 归入
`main`；其他域需要独立配置。题目版本中旧的 Provider、模型字段保留为
历史内容，不参与新的执行选择。不要通过清空题目 LLM 配置迁移 Provider：
题目仍需保留 LLM 能力和单次预算，历史版本也保持不可变。

如果跨越较早的 BYOK 移除版本，仍需核实历史密钥：Gateway 的
`0002_remove_byok_created_by.sql` 删除 `created_by <> '0'` 的用户自建 Provider
及其加密密钥，然后移除 `created_by`。这是**旧 Provider 记录的收缩迁移**，
不代表当前域模型从题目字段中选取。已经应用该迁移的实例不用重复执行旧
字段查询；不能从题目中的旧 Provider ID 判断当前域是否已经配置可用模型。

可执行的升级顺序：

1. 维护窗口前保存完整备份和 Gateway 密钥加密配置，核对已应用的 Gateway 迁移。若
   `0002` 尚未应用，先盘点需要保留的旧用户自建服务及管理授权。
2. 在仍有 `created_by` 的旧 Gateway 数据库中，可用下面的只读查询记录服务
   信息。备份保存加密密钥；不要把解密后的密钥写进日志或工单。

   ```sql
   SELECT id, name, base_url, enabled, created_by
   FROM llm_providers
   WHERE created_by <> '0';
   ```

3. 使用同一目标 Release 协调升级 core、Gateway、Judge、UI 和客户端。Compose 会先
   完成 `migrate` 与 `gateway-migrate` 两个一次性步骤：前者执行 Core
   迁移/系统初始化， 后者执行 Gateway 迁移/默认配额 seed；HTTP 服务只做只读
   schema 兼容检查。旧平台 Provider 和用量归默认域；新学校不继承其密钥。
4. 登录各使用域“LLM”页，核对或配置启用的 Provider、默认模型及日/月额度。
   原用户自建服务如仍需使用，经授权在目标域重新配置有效凭据；源题字段不会
   自动重建它们。已有域设置不会在重启时被旧平台默认值覆盖。
5. 用普通域成员完成一次该域 LLM 题提交，确认调用成功、用量记录属于该域，
   引用公共题时也不使用来源域密钥。缺本域配置或服务停用会明确拒绝新调用。

每次评测尝试保留当时解析的域、Provider、模型与预算；改变默认模型只影响新
尝试，不改写已经受理的配置。不同域可以采用不同模型，成绩不承诺可比。
详细政策与资源上限见[工作空间部署与治理](./workspace-deployment.md)，域内
操作见[配置本域 LLM](../features/workspaces.md#配置本域-llm)。

## 5.1 备份、文件校验与隔离恢复演练

备份体系分三层，必须区分能力边界：

| 层级         | 命令                          | 证明的内容                                                                 |
| ------------ | ----------------------------- | -------------------------------------------------------------------------- |
| 备份         | `noj-cli backup create`       | PostgreSQL/Redis/MinIO/加密环境文件已写入单个 `.nojbackup`                 |
| 文件校验     | `noj-cli backup verify`       | 快照完整、口令可用、dump 结构可解析（`--deep` / `--payload-sha` 逐档加深） |
| 隔离恢复演练 | `noj-cli backup drill <快照>` | 业务真的可以从快照恢复并运行                                               |

`backup verify` 只做**文件级**校验，**不能**证明业务可恢复；`backup drill` 才是
真正的恢复验收演练（会起独立 Compose 项目，分钟级、需 Docker）：

```bash
# 快照是 .nojbackup 单文件，命名形如 snapshot-YYYYMMDD-HHMMSS.nojbackup
noj-cli backup drill backups/snapshot-20260924-021500.nojbackup \
  --passphrase-file /secure/noj-backup-passphrase \
  --docker-host unix:///run/user/1000/docker-noj-restore-drill.sock
```

`--docker-host` 必须指向专门为恢复演练创建的 Docker daemon socket（也可以用
`NOJ_DRILL_DOCKER_HOST` 设置），不能省略，也不能指向承载生产服务的默认
`/var/run/docker.sock`。演练 daemon 应使用独立的 data root、containerd root、
Compose 项目名和网络；创建与清理它需要由维护者在维护窗口按
[P8 演练说明](https://github.com/Neuro-OJ/neuro-oj/blob/7871d31ad22b659deb03eb92c66cb692d787a273/dev-docs/engineering/architecture-remediation-p8.md)执行。

演练会把快照恢复到独立 Compose
项目（独立数据卷、独立子网、不映射宿主机端口、不接触生产卷）， 随后通过真实 API
验收：管理员登录、题目读取、附件（支持包）下载与一次真实双容器评测 （需要 judge
沙箱 Docker socket 与 `noj-evaluator-python` / `noj-solution-python` 镜像，
与生产 judge 使用同一个独立 rootless daemon）。恢复数据后演练按生产依赖顺序保留
并执行 `migrate → gateway-migrate → core` 三个完成态服务；Core 迁移/系统初始化
完成后才运行 Gateway 迁移与默认配额初始化，HTTP 进程只读检查 schema。可用
`--skip-judge` 跳过评测环节。

演练报告（默认写入快照同级的 `restore-drill-report.txt`，权限
600）记录：快照时间、恢复耗时、 数据核对结果（迁移版本/用户数/Redis
键数/对象数）、业务验收明细，以及 RPO/RTO 目标与是否达标 （默认 RPO ≤ 24
小时、RTO ≤ 60 分钟，可用 `--rpo-max-hours` / `--rto-max-minutes` 调整）。
损坏快照、解密失败、数据库恢复失败或业务验收失败都会以非零退出并保留失败现场报告。
演练结束后自动 `down -v` 回收资源；`--keep` 可保留现场供人工检查。

::: danger 口令遗失 = 备份不可恢复 备份快照与 GPG
解密口令文件必须异地独立保存；口令丢失时快照无法恢复，
任何演练都无法弥补。建议每季度以及在重要迁移前各执行一次隔离恢复演练。 :::

### 5.2 定期备份调度与 RPO

恢复演练只能测量
RPO，不能替代定期创建快照。生产安装完成后，建议为当前安装用户注册每日备份任务：

```bash
cd /opt/neuro-oj
noj-cli backup schedule install \
  --schedule '15 2 * * *' \
  --passphrase-file /etc/noj/backup-passphrase
noj-cli backup schedule status
```

任务只维护自己标记的 crontab
区块，不覆盖其他任务；每次执行会保留快照并将输出写入
`backups/backup-cron.log`。默认每日 02:15
执行，实际时间按服务器时区计算。建议把备份目录和
口令文件放在独立磁盘/主机，并由监控检查
`noj_backup_last_success_unix_time`；任务失败时应立即
检查日志和磁盘空间。删除任务使用 `noj-cli backup schedule remove`。

每日快照将 RPO 控制在约 24
小时以内，但无法保证精确上限：任务失败、主机离线或异地复制延迟 都会扩大实际
RPO。正式验收仍须记录最近快照时间、RPO、RTO 以及备份是否异地保存。

## 6. 卸载

```bash
# 删除容器、网络和本地镜像，保留配置和数据卷
noj-cli uninstall

# 明确删除全部数据和安装目录（不可恢复）
noj-cli uninstall --all --yes
```

::: danger 不可逆：`uninstall --all` 完全删除会连同 PostgreSQL、Redis、MinIO
数据卷、备份与安装目录一并删除， **无法恢复**。普通卸载（不带
`--all`）只删容器/网络/本地镜像，要求交互输入 `UNINSTALL`；完全删除要求输入
`DELETE ALL` 或使用 `--yes`。 执行前请务必确认备份已保存到其他位置。 :::

## 7. CLI 配置模式与源码运行

`noj-cli install/start/stop/status/update/uninstall/logs/backup/verify/config check`
管理 `.env.prod` 生产部署； 全部运维能力由 `noj-cli` 的 TS
实现直接完成（`src/prod/`），不再经任何 bash 脚本转发，
因此配置、服务名与数据卷与旧版本完全一致。
`noj-cli backup restore <快照> --confirm` 要求目标 Compose
服务已停止；`backup verify` 与 `backup drill` 用于校验和演练。

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

Release workflow 在生产镜像验证通过后，编译并发布 Linux amd64 CLI 及 SHA-256
校验文件。 旧 Release 没有这些资产时不能使用新安装器安装；需要使用包含 CLI 的新
Release 或该旧版本自身的安装器。
