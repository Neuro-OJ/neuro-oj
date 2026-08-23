## Why

项目当前只有开发用 `docker-compose.yml`、E2E 用 Dockerfile 与 CI/E2E 工作流，没有面向公测的生产镜像、发布流水线和可落地的 Docker 部署配置。下一步发布公测版本需要能够通过 GitHub Actions 在发版时构建并推送镜像到 ghcr.io，并提供一套开箱即用、默认安全的生产 Docker Compose 配置。

## What Changes

- 新增生产 Dockerfile：`noj-core`、`noj-ui`、`noj-judge` 三个服务镜像，以及 `noj-evaluator-python` / `noj-solution-python` 两个评测运行时镜像。
- 新增 `.dockerignore`，避免把本地依赖、构建产物、日志和密钥带入镜像。
- 新增生产 Docker Compose 配置 `docker-compose.prod.yml`：包含反向代理（Nginx）、UI、Core、Judge、PostgreSQL、Redis、MinIO（或外部 S3）服务。
- 新增 `deploy/nginx/` 反向代理与安全头配置；容器内 Nginx 只暴露 80，TLS 由外部边缘终止。
- 新增 `.env.prod.example`，全部敏感项使用占位符，禁止默认弱口令。
- 新增 GitHub Actions 发布工作流 `.github/workflows/release.yml`：仅在 GitHub Release 发布时构建并推送全部镜像到 ghcr.io，使用 `vX.Y.Z` 与 `latest` 标签；**不在每次提交时触发**。
- 安全加固：生产镜像以非 root 运行、移除开发工具与调试依赖、容器默认 `read_only`/`no-new-privileges`、限制资源、健康检查、Compose 不暴露 Core/Judge/数据库端口到宿主机、Redis 与 MinIO 强制密码、Nginx 注入安全响应头。
- 将公测部署流程写入 `noj-docs/docs/operators/`，并移除旧的开发期部署方法（`local-start.md` 与相关 devtool 部署描述）。

## Capabilities

### New Capabilities

- `production-release-pipeline`: 定义发版时构建/推送 ghcr.io 镜像的 CI/CD 行为、镜像命名与标签策略，以及生产 Docker 部署配置和安全基线。

### Modified Capabilities

无。

## Impact

- 新增文件：`noj-core/Dockerfile`、`noj-ui/Dockerfile`、`noj-judge/Dockerfile`、各模块 `.dockerignore`、`docker-compose.prod.yml`、`.env.prod.example`、`deploy/nginx/*`、`.github/workflows/release.yml`、`noj-docs/docs/operators/production-deploy.md`。
- 删除/替换：`noj-docs/docs/operators/local-start.md` 及旧开发期部署描述。
- 现有文件：`noj-core/src/db/migrate.ts` 支持 `NOJ_MIGRATIONS_DIR`；`noj-core/src/services/seed/seed-system.ts` 支持 `JUDGE_IMAGE_BASE`（不影响本地开发默认值）。
- 依赖/系统：GitHub Container Registry（ghcr.io）、Docker、Nginx；公测部署需要域名与外部 TLS 终止。
- 明确非目标：数据库高可用、Redis 哨兵/集群、监控告警、日志聚合、Kubernetes/Helm、自动扩缩容（后续再做）。
