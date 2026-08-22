## ADDED Requirements

### Requirement: Release 触发的 ghcr.io 镜像发布

系统 SHALL 提供 GitHub Actions 工作流 `.github/workflows/release.yml`，仅在 GitHub Release 发布（`release: types: [published]`）或手动触发（`workflow_dispatch`）时构建并推送镜像到 ghcr.io。该工作流 SHALL NOT 在普通 push / pull_request 上触发。

工作流 SHALL 构建并推送以下镜像到 `ghcr.io/neuro-oj/`：

- `noj-core`
- `noj-ui`
- `noj-judge`
- `noj-evaluator-python`
- `noj-solution-python`

每个镜像 SHALL 使用 Release tag（如 `v0.1.0`）作为版本标签，并额外推送 `latest`；若 Release 为 prerelease，SHALL 额外推送 `beta`。

工作流 SHALL 使用 `GITHUB_TOKEN` 登录 ghcr.io，并声明 `packages: write` 权限。

#### Scenario: 发布正式 Release

- **WHEN** 维护者发布一个 tag 为 `v0.1.0` 的 GitHub Release（非 prerelease）
- **THEN** `release.yml` 被触发
- **THEN** 5 个镜像被构建并推送到 `ghcr.io/neuro-oj/*:v0.1.0` 与 `ghcr.io/neuro-oj/*:latest`
- **THEN** 普通 push / pull_request 不会触发该工作流

#### Scenario: 发布 prerelease

- **WHEN** 维护者发布一个 tag 为 `v0.2.0-beta.1` 且标记为 prerelease 的 Release
- **THEN** 5 个镜像被推送到 `ghcr.io/neuro-oj/*:v0.2.0-beta.1`、`ghcr.io/neuro-oj/*:beta` 与 `ghcr.io/neuro-oj/*:latest`

#### Scenario: 手动补发

- **WHEN** 维护者在 Actions 页面手动运行 `release.yml`（`workflow_dispatch`）
- **THEN** 工作流使用当前 ref/tag 作为版本标签执行相同的构建与推送

### Requirement: 生产 Dockerfile

每个服务模块 SHALL 提供生产用 Dockerfile，满足以下要求：

- `noj-core/Dockerfile`：多阶段构建，使用 Deno 2.9.5 与 `deno compile` 产出 API server 与 CLI 两个独立二进制；最终镜像只保留二进制、`drizzle/` 迁移目录与 `data/` 题目数据，不包含源码与 Deno 工具链；通过 `NOJ_PROJECT_ROOT` / `NOJ_MIGRATIONS_DIR` 显式指定运行时路径；以非 root 用户运行 API 服务。
- `noj-ui/Dockerfile`：多阶段构建，使用 Deno 2.9.5 与 `deno task compile` 产出单二进制；最终镜像只包含编译后的单二进制与 `ca-certificates`/`wget`，不包含源码、node_modules、开发依赖；以非 root 用户运行。构建期固定 `rolldown@1.2.5` 并运行 `patch-monaco-workers.mjs` 规避 Monaco worker 构建问题。
- `noj-judge/Dockerfile`：多阶段构建（builder + runtime），最终镜像只包含 release 二进制与 `ca-certificates`；可通过挂载 Docker socket 与 Docker daemon 通信。
- `noj-evaluator-python` / `noj-solution-python`：继续使用现有 SDK 镜像 Dockerfile，但纳入 ghcr 构建发布流程。
- 各模块 SHALL 提供 `.dockerignore`，排除 `node_modules`、`target`、`.deno_cache`、`.env*`、日志、`dist`（除 UI 编译产物外）等不应进入构建上下文的内容。
- 镜像 SHALL 声明 `HEALTHCHECK`（core/ui/judge 按服务能力提供）。
- 公测阶段 SHALL 只构建 `linux/amd64` 镜像。

#### Scenario: 构建 noj-core 生产镜像

- **WHEN** 执行 `docker build -f noj-core/Dockerfile noj-core`
- **THEN** 镜像包含可运行的 noj-core 服务、迁移 CLI 与健康检查
- **THEN** 镜像默认用户不是 root
- **THEN** 镜像内不包含 `.env` 或本地密钥

#### Scenario: 构建 noj-ui 生产镜像

- **WHEN** 执行 `docker build -f noj-ui/Dockerfile noj-ui`
- **THEN** 最终镜像不包含 `node_modules` 与源码
- **THEN** 镜像默认用户不是 root
- **THEN** 镜像可通过 `NUXT_API_BASE` / `NUXT_NOJ_ENV` 等环境变量配置运行时行为

#### Scenario: 构建 noj-judge 生产镜像

- **WHEN** 执行 `docker build -f noj-judge/Dockerfile noj-judge`
- **THEN** 最终镜像包含 release 二进制，不包含 `target/` 与 Rust 工具链
- **THEN** 镜像可通过 `REDIS_URL`、`JUDGE_MAX_CONCURRENT_JUDGES` 等环境变量配置

### Requirement: 生产 Docker Compose 配置

系统 SHALL 提供 `docker-compose.prod.yml`，用于公测部署，满足以下要求：

- 所有业务服务镜像来自 `ghcr.io/neuro-oj/*`，版本通过 `NOJ_VERSION` 环境变量控制（默认 `latest`）。
- 仅 Nginx 服务对外暴露一个宿主机端口（默认 `8080`，可通过 `NGINX_PORT` 改为 `80`；TLS 由外部边缘终止）；`ui`、`core`、`judge`、`postgres`、`redis`、`minio` 不向宿主机暴露端口。
- 使用自建 MinIO 作为对象存储，并提供一次性 `minio-init` 服务创建 bucket。
- 提供 `migrate` 一次性服务（`restart: "no"`）执行数据库迁移/初始化；`core` 依赖其成功完成。
- 所有敏感配置通过 `.env.prod`（由 `.env.prod.example` 复制）注入，禁止硬编码默认密码。
- PostgreSQL、Redis、MinIO SHALL 使用用户提供的强密码，未设置时 compose 启动失败。
- 每个服务 SHALL 配置 `restart: unless-stopped` 与健康检查（除一次性 migrate 外）。
- `judge` SHALL 挂载 Docker socket、使用 `read_only: true`、`tmpfs: /tmp`、`cap_drop: [ALL]`、`security_opt: [no-new-privileges:true]`，并设置资源限制。
- `core`、`ui` SHALL 以非 root 用户运行，并设置内存/CPU 限制。

#### Scenario: 使用 .env.prod 启动生产栈

- **WHEN** 维护者复制 `.env.prod.example` 为 `.env.prod` 并填写真实配置
- **THEN** `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d` 可启动 Nginx/UI/Core/Judge/PostgreSQL/Redis/MinIO
- **THEN** 只有 Nginx 的 80/443 暴露在宿主机
- **THEN** 任一必需密码未设置时 compose 在启动前报错

#### Scenario: 升级版本

- **WHEN** 维护者将 `.env.prod` 中 `NOJ_VERSION` 改为新的 Release tag 并重新 `up -d`
- **THEN** 业务服务使用新版本 ghcr 镜像重新创建
- **THEN** 数据卷保持不变

### Requirement: 反向代理与安全基线

系统 SHALL 提供 `deploy/nginx/default.conf`，作为公测部署的反向代理配置，满足：

- 容器内 Nginx 只监听 HTTP 80，**不处理 TLS**；TLS 由外部边缘（宿主机 Nginx / Caddy / 云 LB）终止。
- 默认将请求代理到 `ui:3000`。
- 提供 `location = /healthz` 代理到 `core:8000/health` 供探活。
- 设置安全响应头：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: strict-origin-when-cross-origin`、基础 `Content-Security-Policy`。
- 对 SSE/长连接设置 `proxy_buffering off`、`proxy_read_timeout 1h`、`proxy_http_version 1.1`。
- 透传 `X-Forwarded-For` / `X-Forwarded-Proto`，配合 noj-core 的 `TRUSTED_PROXIES` 校验。

#### Scenario: 外部边缘终止 TLS

- **WHEN** 外部 Nginx/Caddy/云 LB 收到 `https://example.com` 请求并终止 TLS
- **THEN** 外部边缘将解密后的 HTTP 请求转发到容器 Nginx 的 80 端口，并设置 `X-Forwarded-Proto: https`
- **THEN** 容器 Nginx 将请求代理到 `ui:3000`
- **THEN** 响应包含安全响应头

#### Scenario: 探活端点

- **WHEN** 运维请求 `https://example.com/healthz`
- **THEN** 外部边缘转发到容器 Nginx，Nginx 将请求代理到 `core:8000/health`
- **THEN** 返回 noj-core 的健康状态 JSON

### Requirement: 公测安全基线

公测部署 SHALL 满足以下安全基线：

- 生产环境变量模板 `.env.prod.example` SHALL 只包含占位符，不得包含可用的默认密码/密钥。
- 生产 Compose SHALL NOT 使用开发默认凭据（`noj/noj`、`minioadmin/minioadmin`、无密码 Redis）。
- Redis SHALL 启用密码与 AOF 持久化；Compose 中通过 `--requirepass` 和 `--appendonly yes` 配置。
- 数据库、Redis、MinIO 服务 SHALL 不向宿主机暴露端口。
- noj-ui 生产环境 SHALL 设置 `NUXT_NOJ_ENV=production`（或 `NODE_ENV=production`），使登录 Cookie 启用 `Secure`。
- noj-core SHALL 设置 `NOJ_ENV=production`，启用日志脱敏与 `TRUSTED_PROXIES` 强制校验。
- 构建镜像时 SHALL NOT 把 `.env`、密钥、日志、缓存目录复制进镜像。

#### Scenario: 未配置 Redis 密码

- **WHEN** `.env.prod` 中 `REDIS_PASSWORD` 为空
- **THEN** `docker-compose.prod.yml` 启动前报错，拒绝启动

#### Scenario: 生产 Cookie Secure

- **WHEN** noj-ui 以 `NUXT_NOJ_ENV=production` 运行且用户通过 HTTPS 登录
- **THEN** `noj:token` 与 `noj:session` Cookie 带有 `Secure` 标志

#### Scenario: 镜像不含敏感文件

- **WHEN** 检查生产镜像文件系统
- **THEN** 不存在 `.env`、`node_modules/.env`、`target/` 或本地日志文件

### Requirement: 公测部署文档

系统 SHALL 将公测部署流程写入 `noj-docs/docs/operators/production-deploy.md`，至少包含：

- 前置条件（Docker、域名、外部 TLS 终止、ghcr 访问）。
- 初始化步骤：复制 `.env.prod.example` → 填写配置 → 运行 `migrate` → 启动服务。
- 评测镜像白名单更新：将 `judge_images` 中的镜像更新为 ghcr 全限定名。
- 日常运维：查看状态、日志、健康检查。
- 升级与回滚：修改 `NOJ_VERSION` 重新部署；数据库迁移不回滚的注意事项。
- 备份提示：PostgreSQL、Redis、MinIO/S3 数据备份（详细可靠性方案后续补充）。

系统 SHALL 移除 noj-docs 中旧的开发期部署方法（`local-start.md` 及 `devtool.sh` 部署描述），
并将运营者文档侧边栏的“本地启动”替换为“生产部署”。

#### Scenario: 按文档完成公测部署

- **WHEN** 运维按 `noj-docs/docs/operators/production-deploy.md` 操作
- **THEN** 可完成从空服务器到可访问 HTTPS 公测站点的部署
- **THEN** 文档包含评测镜像白名单更新步骤，避免 judge 因镜像不在白名单而拒绝任务

#### Scenario: 运营者文档不再展示旧开发期部署

- **WHEN** 用户打开 noj-docs 运营者文档
- **THEN** 侧边栏显示“生产部署”而不是“本地启动”
- **THEN** 不再出现“开发期部署与运维方式尚未成熟”的警示块
