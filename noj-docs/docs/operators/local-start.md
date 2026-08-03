# 本地启动

::: danger 文档状态：部署运维方案尚未成熟
本分区文档描述的是**开发期部署与运维方式**（手动分步启动、开发期脚本），**尚未提供面向生产的一键部署方案**——当前不具备守护进程管理、TLS、备份、升级等生产级能力，生产部署请谨慎参考。项目后续将提供成熟的一键部署方式，届时本文档将整体更新。
:::

本文覆盖从零启动整套 Neuro OJ 环境（PostgreSQL + Redis + noj-core + noj-ui + noj-judge），以及生产部署、环境变量与备份恢复的关键注意点。

## 环境要求

- Deno 2.x
- Rust
- Docker（noj-judge 评测沙箱必需）
- 系统 `zip` 命令

## 开发期脚本（devtool.sh，不成熟）

::: danger 部署方式尚未成熟
`scripts/dev/devtool.sh` 是**开发期**的单文件编排脚本，仅适合本地开发与尝鲜，**不是运营者部署的推荐方式**：它面向开发环境（热重载、前台进程、日志文件），不具备生产部署所需的守护进程管理、TLS、备份与升级保障。

正式部署请参考下文[手动分步启动](#手动分步启动)；项目后续会提供**成熟的一键部署方式**（容器编排 / 安装包），届时本文档将同步更新。
:::

```bash
bash scripts/dev/devtool.sh install-deps --check-only   # 检测 zip / Deno / Rust / Docker
bash scripts/dev/devtool.sh init-env                    # 首次：复制 env.example → noj-core/.env
bash scripts/dev/devtool.sh start                      # 默认 all：infra → core → ui → judge
bash scripts/dev/devtool.sh status                     # 查看运行状态（支持 --json）
bash scripts/dev/devtool.sh stop                       # 反向顺序停止全部
```

`start` / `stop` 支持指定目标：`infra | core | ui | judge | all`（默认 `all`）。日志输出到 `scripts/dev/logs/{core,ui,judge}.log`。

## 手动分步启动

### 1. 基础设施

在仓库根目录运行：

```bash
docker compose up -d
```

默认启动 PostgreSQL 与 Redis（数据保存在 docker 卷中，`docker compose down` 不会丢失数据；只有 `down -v` 才会删卷重置）。

### 2. noj-core

```bash
cd noj-core
deno task dev-setup
deno task dev
```

`deno task dev-setup` 会依次执行数据库迁移、系统初始化、管理员引导，并构建/导入示例题目包。`deno task dev` 启动后端开发服务（默认 `http://localhost:8000`）。

### 3. noj-ui

```bash
cd noj-ui
deno install
deno task dev
```

默认前端地址为 `http://localhost:3000`，开发模式会把 API 请求代理到 noj-core。

### 4. noj-judge

```bash
cd noj-judge
cargo run
```

Judge Worker 需要能访问 Docker daemon，并且 Redis 地址要与 noj-core 使用的 Redis 一致。

### 推荐启动顺序

1. PostgreSQL 和 Redis。
2. `noj-core`，让数据库迁移、系统初始化和结果消费者先启动。
3. `noj-ui`。
4. `noj-judge`。

## 关键环境变量

完整清单以各模块的 `.env.example` 与模块文档（`noj-core/CLAUDE.md` 等）为准，这里列出最关键的：

### noj-core

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | PostgreSQL 连接串 |
| `JWT_SECRET` | JWT 签名密钥，**至少 32 字符**的随机串（`openssl rand -base64 48`） |
| `JWT_EXPIRES_IN` | 令牌有效期，默认 `24h` |
| `REDIS_URL` | Redis 连接串 |
| `PORT` | HTTP 监听端口，默认 `8000` |
| `ADMIN_EMAIL` / `ADMIN_PASS` | 初始化管理员账号 |
| `STORAGE_PROVIDER` | `local` 或 `s3`（支持包存储） |
| `EMAIL_PROVIDER` | `mock` / `aliyun` / `tencent`（密码重置邮件） |
| `Neuro OJ_ENV` | `production` 时强制要求配置可信代理白名单并启用日志脱敏 |

### noj-ui

| 变量 | 说明 |
|------|------|
| `NUXT_API_BASE` | noj-core API 地址（服务端私有），默认 `http://localhost:8000` |

### noj-judge

| 变量 | 说明 |
|------|------|
| `REDIS_URL` | Redis 连接串，需与 noj-core 一致 |
| `JUDGE_QUEUE` / `RESULT_QUEUE` | 评测任务 / 结果队列名 |
| `POOL_INITIAL_SIZE` / `POOL_MAX_SIZE` | 容器池预热与上限 |
| `POOL_MEMORY_MB` | 容器内存硬上限（MB） |

## 生产部署注意

- **JWT_SECRET**：必须使用 32+ 字符的强随机串，任何环境不得使用示例值。
- **Neuro OJ_ENV=production**：会强制要求显式配置 `TRUSTED_PROXIES`（可信反向代理白名单），并启用日志安全（submission_id 截断、score 隐藏、DB 密码脱敏）。
- **CORS**：生产环境通过 `CORS_ALLOWED_ORIGINS` 配置白名单域名，空列表拒绝所有跨域请求；开发环境默认放行 `*`。
- **存储**：多实例或正式部署建议 `STORAGE_PROVIDER=s3`（兼容 MinIO / AWS S3），避免依赖单机文件系统。
- **邮件**：密码重置依赖邮件发送，正式环境配置 `EMAIL_PROVIDER=aliyun` 或 `tencent`，`mock` 仅用于开发（输出到控制台）。

### 前端单二进制

noj-ui 支持编译为单二进制，便于部署与分发：

```bash
cd noj-ui
deno task compile      # 输出 dist/noj-ui
cd dist && ./noj-ui    # 默认监听 :3000
```

### 反向代理与 TLS

生产环境通常在 noj-ui / noj-core 前部署 Nginx、Caddy 等反向代理：

- 对外只暴露 443/80，TLS 终止在反代层。
- 认证依赖 **HTTP-only Cookie**（`noj:token`，JS 不可见，`sameSite: lax`），请保持 Cookie 直通、不开启跨域改写。
- 若反代设置 X-Forwarded-* 头，必须在 noj-core 配置 `TRUSTED_PROXIES`，否则限流与 IP 黑名单会把所有请求视为同一来源。

## 备份与恢复

- **PostgreSQL**：使用 `pg_dump` 定期备份，例如
  `pg_dump "postgres://noj:noj@localhost:5432/noj" -F c -f backup.dump`。
- **Redis**：评测队列是瞬时数据（重启可恢复），但缓存与锁会重建；如需保留请备份 RDB/AOF 文件（docker 卷内）。
- **支持包**：`local` 模式的支持包在 `noj-core/data/packages/`，应一并纳入备份；`s3` 模式由对象存储负责。
- 迁移顺序：恢复数据库 → 启动 noj-core（自动执行迁移）→ noj-ui → noj-judge。
