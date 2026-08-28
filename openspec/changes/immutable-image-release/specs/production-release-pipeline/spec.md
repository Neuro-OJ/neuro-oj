## MODIFIED Requirements

### Requirement: Release 触发的 ghcr.io 镜像发布

系统 SHALL 提供 GitHub Actions 工作流 `.github/workflows/release.yml`，仅在 GitHub Release 发布（`release: types: [published]`）或手动触发（`workflow_dispatch`）时构建并推送镜像到 ghcr.io。该工作流 SHALL NOT 在普通 push / pull_request 上触发。

工作流 SHALL 构建并推送以下六个镜像到 `ghcr.io/neuro-oj/`：

- `noj-core`
- `noj-ui`
- `noj-judge`
- `noj-llm-gateway`
- `noj-evaluator-python`
- `noj-solution-python`

每个镜像 SHALL 先使用唯一候选标签构建并完成供应链门禁，再以当前 Release tag 作为不可变版本标签发布。工作流 MUST NOT 发布或依赖 `latest`、`beta` 等可变标签作为生产部署输入。

#### Scenario: 发布正式 Release

- **WHEN** 维护者发布一个合法版本标签的 GitHub Release
- **THEN** `release.yml` 被触发并为六个镜像生成唯一候选构建
- **THEN** 候选镜像通过安全门禁后，六个镜像均发布到对应的 Release 版本标签
- **THEN** 普通 push / pull_request 不会触发该工作流

#### Scenario: 发布 prerelease

- **WHEN** 维护者发布一个 prerelease Release
- **THEN** 工作流使用该 Release 的不可变版本标签发布镜像
- **THEN** 工作流不把 `beta` 或 `latest` 作为生产部署标签

#### Scenario: 手动补发

- **WHEN** 维护者在 Actions 页面手动运行 `release.yml`
- **THEN** 工作流仅接受合法 Release/tag ref 作为版本标识
- **THEN** 工作流使用当前 ref/tag 作为版本标签执行相同的安全门禁和发布验证

### Requirement: 生产 Dockerfile

每个服务模块 SHALL 提供生产用 Dockerfile，满足以下要求：

- `noj-core/Dockerfile`：多阶段构建，使用 Deno 2.9.5 与 `deno compile` 产出 API server 与 CLI 两个独立二进制；最终镜像只保留二进制、`drizzle/` 迁移目录与 `data/` 题目数据，不包含源码与 Deno 工具链；通过 `NOJ_PROJECT_ROOT` / `NOJ_MIGRATIONS_DIR` 显式指定运行时路径；以非 root 用户运行 API 服务；所有基础镜像使用 digest 固定。
- `noj-ui/Dockerfile`：多阶段构建，使用 Deno 2.9.5 与 `deno task compile` 产出单二进制；最终镜像只包含编译后的单二进制与 `ca-certificates`/`wget`，不包含源码、node_modules、开发依赖；以非 root 用户运行；构建期固定 `rolldown@1.2.5` 并运行 `patch-monaco-workers.mjs`；所有基础镜像使用 digest 固定。
- `noj-judge/Dockerfile`：多阶段构建（builder + runtime），最终镜像只包含 release 二进制与 `ca-certificates`；可通过挂载 Docker socket 与 Docker daemon 通信；所有基础镜像使用 digest 固定。
- `noj-evaluator-python` / `noj-solution-python`：继续使用现有 SDK 镜像 Dockerfile，但纳入 ghcr 构建发布流程；基础镜像使用 digest 固定。
- 各模块 SHALL 提供 `.dockerignore`，排除 `node_modules`、`target`、`.deno_cache`、`.env*`、日志、`dist`（除 UI 编译产物外）等不应进入构建上下文的内容。
- 镜像 SHALL 声明 `HEALTHCHECK`（core/ui/judge 按服务能力提供）。
- 公测阶段 SHALL 只构建 `linux/amd64` 镜像。

#### Scenario: 构建生产镜像

- **WHEN** CI 使用生产 Dockerfile 构建任一发布镜像
- **THEN** 所有基础镜像均解析到声明的 digest
- **THEN** 镜像包含对应运行时所需内容，不包含源码、密钥和构建工具链
- **THEN** 镜像默认用户和健康检查满足对应模块的生产要求

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

#### Scenario: 基础镜像 digest 漂移

- **WHEN** 生产 Dockerfile 的基础镜像只使用 tag 或 digest 被未经审查地替换
- **THEN** 供应链配置检查失败

### Requirement: 生产 Docker Compose 配置

系统 SHALL 提供 `docker-compose.prod.yml`，用于公测部署，满足以下要求：

- 所有业务服务镜像来自 `ghcr.io/neuro-oj/*`，版本通过必填的 `NOJ_VERSION` 环境变量控制；`NOJ_VERSION` MUST 是已发布的不可变 Release tag，生产 Compose 不得默认回退到 `latest`。
- 仅 Nginx 服务对外暴露一个宿主机端口（默认 `8080`，可通过 `NGINX_PORT` 改为 `80`；TLS 由外部边缘终止）；`ui`、`core`、`judge`、`postgres`、`redis`、`minio` 不向宿主机暴露端口。
- 使用自建 MinIO 作为对象存储，并提供一次性 `minio-init` 服务创建 bucket。
- 提供 `migrate` 一次性服务（`restart: "no"`）执行数据库迁移/初始化；`core` 依赖其成功完成。
- 所有敏感配置通过 `.env.prod`（由 `.env.prod.example` 复制）注入，禁止硬编码默认密码。
- PostgreSQL、Redis、MinIO SHALL 使用用户提供的强密码，未设置时 compose 启动失败。
- 每个服务 SHALL 配置 `restart: unless-stopped` 与健康检查（除一次性 migrate 外）。
- `judge` SHALL 挂载 Docker socket、使用 `read_only: true`、`tmpfs: /tmp`、`cap_drop: [ALL]`、`security_opt: [no-new-privileges:true]`，并设置资源限制。
- `core`、`ui` SHALL 以非 root 用户运行，并设置内存/CPU 限制。
- 生产 Compose 中的基础设施镜像（Nginx、PostgreSQL、Redis、MinIO 和 `mc`）MUST 使用 digest 固定。

#### Scenario: 使用已发布版本启动生产栈

- **WHEN** 维护者在 `.env.prod` 中填写合法的 `NOJ_VERSION` 并执行生产 Compose
- **THEN** 业务服务使用该 Release 版本镜像启动
- **THEN** Compose 配置不会解析到 `latest` 或其他默认可变标签
- **THEN** 必需密码未设置时 compose 在启动前报错

#### Scenario: 使用 .env.prod 启动生产栈

- **WHEN** 维护者复制 `.env.prod.example` 为 `.env.prod` 并填写真实配置及已发布的 `NOJ_VERSION`
- **THEN** `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d` 可启动 Nginx/UI/Core/Judge/PostgreSQL/Redis/MinIO
- **THEN** 只有 Nginx 的 80/443 暴露在宿主机
- **THEN** 任一必需密码未设置时 compose 在启动前报错

#### Scenario: 未填写生产版本

- **WHEN** `.env.prod` 未设置 `NOJ_VERSION`
- **THEN** Compose 在启动前报错并拒绝启动

#### Scenario: 升级版本

- **WHEN** 维护者将 `.env.prod` 中 `NOJ_VERSION` 改为另一个已验证的 Release tag 并重新部署
- **THEN** 业务服务使用新版本镜像重新创建
- **THEN** 数据卷保持不变
- **THEN** 部署脚本在升级前创建并校验生产备份

### Requirement: 公测部署文档

系统 SHALL 将公测部署流程写入 `noj-docs/docs/operators/production-deploy.md`，至少包含：

- 前置条件（Docker、域名、外部 TLS 终止、ghcr 访问）。
- 初始化步骤：复制 `.env.prod.example` → 填写配置 → 设置已验证的 Release `NOJ_VERSION` → 运行 `migrate` → 启动服务。
- 评测镜像白名单更新：将 `judge_images` 中的镜像更新为 ghcr 全限定名。
- 日常运维：查看状态、日志、健康检查和当前部署版本/digest。
- 升级与回滚：只使用已签名验证的 Release tag；升级前备份；失败时恢复上一个已验证版本；明确数据库迁移不自动回滚及兼容性要求。
- 备份提示：PostgreSQL、Redis、MinIO/S3 数据备份（详细可靠性方案后续补充）。

系统 SHALL 移除 noj-docs 中旧的开发期部署方法（`local-start.md` 及 `devtool.sh` 部署描述），并将运营者文档侧边栏的“本地启动”替换为“生产部署”。

#### Scenario: 按文档完成版本化部署

- **WHEN** 运维按文档使用已验证的 Release tag 部署
- **THEN** 可完成从空服务器到可访问 HTTPS 公测站点的部署
- **THEN** 文档包含镜像签名验证、版本记录、升级和回滚步骤

#### Scenario: 按文档执行回滚

- **WHEN** 新版本健康检查或 smoke test 失败
- **THEN** 运维可按文档切换到上一个已验证 Release tag
- **THEN** 文档明确数据库迁移兼容性和不可自动降级的风险

#### Scenario: 按文档完成公测部署

- **WHEN** 运维按文档使用已验证的 Release tag 操作
- **THEN** 可完成从空服务器到可访问 HTTPS 公测站点的部署
- **THEN** 文档包含评测镜像白名单更新步骤，避免 judge 因镜像不在白名单而拒绝任务

#### Scenario: 运营者文档不再展示旧开发期部署

- **WHEN** 用户打开 noj-docs 运营者文档
- **THEN** 侧边栏显示“生产部署”而不是“本地启动”
- **THEN** 不再出现“开发期部署与运维方式尚未成熟”的警示块
