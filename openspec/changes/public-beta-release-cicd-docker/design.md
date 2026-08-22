## Context

项目目前只有开发/测试用的 Docker 配置：

- `docker-compose.yml`：本地 PG/Redis/MinIO，默认弱口令。
- `docker-compose.e2e.yml` + `Dockerfile.e2e`：CI 全链路测试用，包含开发工具，不适合作为生产镜像。
- `noj-ui` 没有 Dockerfile，`noj-core` 只有 E2E 镜像，`noj-judge` 的 E2E 镜像可参考但不是正式发布物。
- CI/E2E 已覆盖测试，但没有“发版时构建并推送镜像”的 CD 流程。

公测版本需要一个可重复、可审计的发布路径：GitHub Release 触发构建，产物推送到 `ghcr.io`，部署侧用一套默认安全的 Docker Compose 拉起完整服务。

## Goals / Non-Goals

**Goals:**

- 提供生产 Dockerfile：`noj-core`、`noj-ui`、`noj-judge`、`noj-evaluator-python`、`noj-solution-python`。
- 提供 GitHub Actions 发布工作流：仅在 Release 发布时构建并推送镜像到 ghcr.io，不随每次提交触发。
- 提供 `docker-compose.prod.yml`、`.env.prod.example`、Nginx 反向代理/安全头配置（TLS 由外部边缘终止）。
- 提供公测部署文档：初始化、升级、回滚、评测镜像白名单更新。
- 包含面向公测的必要安全加固：非 root（除 judge 因 Docker socket 需要）、无默认口令、不暴露内部端口、只读根文件系统、资源限制、健康检查、安全响应头。

**Non-Goals:**

- 不实现数据库高可用、Redis 哨兵/集群、监控告警、日志聚合、分布式追踪。
- 不实现 Kubernetes/Helm、自动扩缩容、蓝绿/金丝雀发布平台。
- 不实现完整渗透测试或 gVisor/Firecracker 级沙箱强隔离（后续安全迭代）。
- 不修改核心业务功能。

## Decisions

### 1. 镜像仓库与命名

统一使用 `ghcr.io/neuro-oj/<image>`：

| 镜像 | 构建上下文 | Dockerfile |
|---|---|---|
| `ghcr.io/neuro-oj/noj-core` | `noj-core/` | `noj-core/Dockerfile` |
| `ghcr.io/neuro-oj/noj-ui` | `noj-ui/` | `noj-ui/Dockerfile` |
| `ghcr.io/neuro-oj/noj-judge` | `noj-judge/` | `noj-judge/Dockerfile` |
| `ghcr.io/neuro-oj/noj-evaluator-python` | `noj-judge/` | `noj-judge/docker/evaluator-python/Dockerfile` |
| `ghcr.io/neuro-oj/noj-solution-python` | `noj-judge/` | `noj-judge/docker/solution-python/Dockerfile` |

理由：评测 Worker 的 `image_allowed()` 只校验镜像 basename 前缀（`noj-`），因此即使使用全限定 ghcr 镜像名，默认 `JUDGE_IMAGE_PREFIX=noj-` 仍可放行。

### 2. 发布触发与标签策略

- 使用 GitHub Actions `on: release: types: [published]`，另保留 `workflow_dispatch` 供手动补发。
- 不在 `push` / `pull_request` 上触发镜像发布。
- 标签：
  - 始终推送 `vX.Y.Z`（取自 Release tag，如 `v0.1.0`）。
  - 始终推送 `latest`，表示当前可部署公测版本。
  - 若 Release 标记为 prerelease，额外推送 `beta`。

理由：公测阶段“latest”即当前推荐部署版本；pre-release 单独给 `beta` 便于灰度。

### 3. 生产镜像形态

- `noj-core`：多阶段构建。builder 使用 `denoland/deno:debian-2.9.5`，通过 `deno compile` 产出两个独立二进制：API server（`noj-core`）与 CLI（`noj`，用于 migrate/init/admin/problems）。final 使用 `debian:bookworm-slim`，只复制二进制、`drizzle/` 迁移目录与 `data/` 题目数据，以非 root 用户运行。通过 `NOJ_PROJECT_ROOT=/app` 与 `NOJ_MIGRATIONS_DIR=/app/drizzle` 显式指定项目根/迁移目录，避免 compiled 二进制中 `import.meta.url`/`import.meta.dirname` 路径失效。
- `noj-ui`：多阶段构建。builder 使用 `denoland/deno:debian-2.9.5` 执行 `deno task compile` 产出单二进制；final 使用 `debian:bookworm-slim` + `ca-certificates` + `wget`，以非 root 运行 `./noj-ui`。运行时不需要源码、node_modules 或 Deno 工具链。构建期通过 `scripts/patch-monaco-workers.mjs` 改写 Monaco 内置 workerManager，并将 `rolldown` 固定到 `1.2.5`，规避 Vite/Rolldown worker 插件在 Deno 下的构建报错。
- `noj-judge`：多阶段构建，builder 使用 `rust:1.86-slim-bookworm`，final 使用 `debian:bookworm-slim` + `ca-certificates`，只保留 release 二进制。Judge 需要访问宿主 Docker socket，公测阶段容器内以 root 运行（信任边界在 Docker 沙箱层）；通过 `read_only: true`、`tmpfs: /tmp`、`cap_drop: [ALL]`、`no-new-privileges` 降低自身被攻破后的影响。
- 评测运行时镜像继续沿用现有 `python:3.12-slim` 非 root 镜像，仅增加 ghcr 构建/推送。
- 平台固定 `linux/amd64`，公测阶段不支持 arm64。

理由：沿用项目已验证的 Deno/Rust 构建方式，避免引入 Node 工具链；UI 单二进制部署简单；Judge 的 root 是访问 Docker socket 的必要妥协。

### 4. 生产 Compose 拓扑

`docker-compose.prod.yml` 只对外暴露 Nginx 的一个宿主机端口（默认 `8080`，可配置为 `80`；TLS 由外部边缘终止）：

```
nginx (反代/安全头，TLS 由外部边缘终止)
  └─> ui:3000 (SSR，代理 /api 到 core)
        └─> core:8000 (API + MQ producer/consumer)
              ├─> postgres:5432
              ├─> redis:6379 (带密码)
              └─> minio:9000 (可选自建对象存储)
judge (Docker socket + Redis)
  └─> minio:9000 (下载 presigned 支持包)
```

- `core` 不暴露宿主端口；`judge` 不暴露端口；`postgres`/`redis`/`minio` 仅内部网络。
- `core` 使用 `env_file: .env.prod` 注入配置，健康检查 `/health`。
- `judge` 挂载 `/var/run/docker.sock` 与 `tmpfs`，通过 `REDIS_URL` 连接 Redis。
- 提供一次性 `migrate` 服务（`restart: "no"`）用于部署时先迁移/初始化；`core` 依赖其成功完成。

### 5. Nginx 与安全头

- 容器内的 Nginx **不处理 TLS**；TLS 由宿主机 Nginx / Caddy / 云负载均衡等外部边缘终止。
- `deploy/nginx/default.conf`：只监听 80，代理到 `ui:3000`，并透传 `X-Forwarded-For` / `X-Forwarded-Proto`。
- 额外 `location = /healthz` 代理到 `core:8000/health`，供负载均衡/运维探活。
- 安全头：`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`、基础 CSP；HSTS 由外部 TLS 终止层负责。
- SSE/长连接：`proxy_buffering off`、`proxy_read_timeout 1h`、`proxy_http_version 1.1`。

### 6. 评测镜像白名单更新

`seedJudgeImages()` 支持 `JUDGE_IMAGE_BASE` 环境变量（生产默认 `ghcr.io/neuro-oj/`），初始化时直接把 `judge_images` 写入 ghcr 全限定名（如 `ghcr.io/neuro-oj/noj-evaluator-python`），`mode=all_versions` 以支持 tag 切换。未设置时保持本地开发默认名，向后兼容。

## Risks / Trade-offs

- [ghcr 拉取限流/网络不可达] → 部署文档要求提前 `docker pull` 或配置镜像加速；公测阶段单机部署可接受。
- [Judge 容器以 root 运行以访问 Docker socket] → 通过 `cap_drop ALL`、`no-new-privileges`、`read_only`、`tmpfs` 降低风险；真正的隔离边界仍是评测子容器，后续再引入 Docker socket 代理或 gVisor。
- [UI 单二进制体积较大（约 144MB）] → 公测可接受；后续可改用精简 Nitro server 镜像。
- [自建 MinIO 为单点] → 公测阶段可接受；文档说明可切换外部 S3，并提醒备份 bucket。
- [Release 工作流只构建 linux/amd64] → 公测服务器以 amd64 为主；后续按需增加 arm64。
- [数据库迁移在 `core` 启动时也会自动执行] → 与一次性 `migrate` 服务幂等兼容；文档明确不要并发跑迁移。

## Migration Plan

1. 合并本变更后，新建 GitHub Release（如 `v0.1.0-beta.1`），触发 `release.yml` 构建并推送 5 个镜像到 ghcr.io。
2. 在部署服务器复制 `.env.prod.example` 为 `.env.prod`，填写真实密钥、域名、S3/MinIO 配置。
3. `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d migrate` 执行迁移/初始化。
4. 启动其余服务：`docker compose -f docker-compose.prod.yml --env-file .env.prod up -d`。
5. 通过管理后台或 SQL 更新 `judge_images` 白名单为 ghcr 全限定镜像名。
6. 回滚：`docker compose ... down` 后，将 `.env.prod` 中 `NOJ_VERSION` 指回上一版本并重新 `up -d`；数据库迁移采用只追加策略，不自动回滚 schema。
7. 文档同步：`noj-docs/docs/operators/` 以生产部署为主，旧的开发期部署方法（`local-start.md` 等）移除。

## Open Questions

- 是否需要在公测阶段同时发布 `linux/arm64` 镜像？（当前按 amd64 设计）
- 自建 MinIO 还是直接使用外部 S3？（Compose 两者都支持，默认包含 MinIO 以便开箱即用）
