## 1. 生产 Dockerfile

- [x] 1.1 新增 `noj-core/Dockerfile`：基于 Deno 2.9.5 多阶段构建，使用 `deno compile` 产出 API server 与 CLI 两个独立二进制，最终镜像只保留二进制、drizzle 迁移与 data 目录，非 root 运行、健康检查。
- [x] 1.2 新增 `noj-ui/Dockerfile`：基于 Deno 2.9.5 多阶段构建，使用 `deno task compile` 产出单二进制，最终镜像只保留二进制与 ca-certificates/wget，非 root 运行、健康检查。
- [x] 1.3 新增 `noj-judge/Dockerfile`：多阶段构建（builder + runtime），最终镜像只保留 release 二进制与 ca-certificates，支持挂载 Docker socket。
- [x] 1.4 确认 `noj-evaluator-python` / `noj-solution-python` 现有 Dockerfile 可被 ghcr 工作流构建。

## 2. .dockerignore

- [x] 2.1 新增 `noj-core/.dockerignore`
- [x] 2.2 新增 `noj-ui/.dockerignore`
- [x] 2.3 更新 `noj-judge/.dockerignore`

## 3. 生产 Compose 与反向代理

- [x] 3.1 新增 `docker-compose.prod.yml`：仅暴露 Nginx 80（TLS 由外部边缘终止），包含 migrate/core/ui/judge/postgres/redis/minio/minio-init。
- [x] 3.2 新增 `.env.prod.example`：全部敏感项为占位符，无默认弱口令。
- [x] 3.3 新增 `deploy/nginx/default.conf`：HTTP 反代、安全头、SSE 长连接、/healthz（容器内不处理 TLS）。
- [x] 3.4 新增 `deploy/README.md`（证书与配置挂载说明）。

## 4. Release CI/CD

- [x] 4.1 新增 `.github/workflows/release.yml`：`release: published` + `workflow_dispatch` 触发，构建并推送 5 个镜像到 ghcr.io。
- [x] 4.2 在 workflow 中处理 Release tag / `latest` / `beta` 标签，平台固定 `linux/amd64`。

## 5. 运行时代码适配（deno compile 支持）

- [x] 5.1 修改 `noj-core/src/db/migrate.ts`：支持 `NOJ_MIGRATIONS_DIR` 环境变量，避免 compiled 二进制迁移路径失效。
- [x] 5.2 修改 `noj-core/src/services/seed/seed-system.ts`：`seedJudgeImages()` 支持 `JUDGE_IMAGE_BASE`，生产初始化写入 ghcr 全限定镜像名。
- [x] 5.3 修复 `noj-ui` Docker 构建：`noj-ui/package.json` 固定 `rolldown@1.2.5`，新增 `noj-ui/scripts/patch-monaco-workers.mjs` 在构建期改写 Monaco 内置 workerManager，避免 Vite/Rolldown worker 插件报错。
- [x] 5.4 将 `noj-core` / `noj-ui` Dockerfile 的 Deno 版本统一升级到 `2.9.5`，解决 `deno compile --include` 在 2.8.0 下的 `#entry` 解析问题。
- [x] 5.5 修改 `noj-core/scripts/noj.ts` 支持 `NOJ_PROJECT_ROOT`，并在 `noj-core/Dockerfile` / `docker-compose.prod.yml` 中显式设置为 `/app`，解决 compiled CLI 找不到 `data/` 的问题。
- [x] 5.6 将样例题 `noj-core/data/problems-src/1003/problem.json` 的评测镜像改为 ghcr 全限定名，与生产 `judge_images` 白名单一致。
- [x] 5.7 修复游客访问任意页面被重定向到登录的问题：`useCommunityNotifications` 对未读数接口关闭 `redirectOnUnauthorized`，`Navbar` 仅登录后加载未读数。

## 6. noj-docs 生产部署文档

- [x] 6.1 新增 `noj-docs/docs/operators/production-deploy.md`，并在侧边栏替换“本地启动”为“生产部署”。
- [x] 6.2 更新 `noj-docs/docs/operators/index.md`、`cli.md`、`storage.md`、`admin-guide.md`、`judge-workers.md`，移除“部署运维方案尚未成熟”的开发期部署描述。
- [x] 6.3 删除 `noj-docs/docs/operators/local-start.md` 与根目录 `docs/operators/production-deploy.md` 重复文档。

## 7. 验证

- [x] 7.1 运行 `docker compose -f docker-compose.prod.yml --env-file .env.prod.example config` 验证 compose 语法。
- [x] 7.2 运行 `docker build` 对 `noj-core` / `noj-ui` / `noj-judge` 三个 Dockerfile 做完整构建验证。
- [x] 7.3 运行 `openspec validate public-beta-release-cicd-docker --strict` 验证变更规范。
