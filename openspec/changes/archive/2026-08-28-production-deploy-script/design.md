## Context

生产部署已经由 `docker-compose.prod.yml`、`.env.prod.example` 和运营者文档定义；Compose 包含一次性 `migrate` 服务、core、UI、judge、LLM Gateway、Nginx、PostgreSQL、Redis 和 MinIO。当前缺少统一入口，用户需要手工拼接多条 Compose 和 CLI 命令。开发用 `scripts/dev/devtool.sh` 依赖本机 Deno/Rust 进程，不应复用于生产。

## Goals / Non-Goals

**Goals:**

- 在 `scripts/deploy/deploy.sh` 提供一致的生产生命周期命令。
- 复用现有生产 Compose 的依赖条件、迁移和健康检查，不复制服务拓扑。
- 在执行前完成不泄露 secret 的配置与宿主环境检查。
- 首次安装、升级、停止和备份操作可重复且保留持久化数据。

**Non-Goals:**

- 不重新设计 Docker Compose 服务、网络或卷布局。
- 不自动创建独立 rootless Docker daemon；只检查其 socket 配置。
- 不实现 Kubernetes、Terraform、云数据库或完整灾备系统。
- 不替代 #326 的 PostgreSQL/Redis/MinIO 多副本备份和恢复演练。

## Decisions

### 1. 使用 Bash 薄封装，而不是新增部署运行时

选择 Bash 是因为生产主机已有 Docker Compose，且项目已有 Bash 运维脚本；这样用户不必额外安装 Deno、Rust 或 Node.js。脚本通过数组传递 Compose 参数，避免对环境文件执行 `source`，防止 secret 中的特殊字符或命令替换带来风险。

备选方案是把部署逻辑写入 Deno CLI，但生产镜像中的部署主机未必安装 Deno，且会重复已有 Compose 能力。

### 2. 以生产 Compose 为唯一编排来源

脚本固定解析仓库根目录的 `docker-compose.prod.yml`，通过 `--env-file` 注入 `.env.prod`，并将 Compose 子命令的退出码原样传递。迁移、系统初始化、管理员引导和容器健康检查继续由 Compose 定义，避免脚本和 Compose 出现两套依赖顺序。

### 3. 配置初始化采用“复制模板 + 生成部分随机密钥”

首次 `install` 只在目标文件不存在时复制 `.env.prod.example`，然后为数据库、Redis、MinIO、JWT、TFA 和 LLM Gateway 等密钥生成随机值；域名、版本、邮件 Provider、S3 应用配置和管理员账号仍要求用户填写。已有文件只检查，不自动重写。

脚本不在 stdout/stderr 打印 secret；检查结果只显示配置键和脱敏后的原因。环境文件权限固定收紧为 `600`，并在启动前拒绝占位符。

### 4. 命令边界

- `install`：前置检查、初始化配置、拉取镜像、运行一次性迁移服务、启动全部服务、等待关键服务健康。
- `start`：检查配置后启动全部服务；Compose 会处理已完成的迁移服务。
- `upgrade`：检查配置、拉取目标版本、重新启动服务并等待健康。
- `stop`：使用 Compose stop，保留所有数据卷。
- `status`：显示 Compose 状态，并额外标记配置文件和隔离 socket 检查结果。
- `logs [service]`：默认显示最近日志，可选服务名和 follow 模式。
- `backup`：只创建 PostgreSQL custom-format 备份到 `backups/`，不删除或覆盖已有备份。

### 5. 网络与镜像策略

脚本不在应用层实现镜像代理，而是让 Docker daemon 的 registry mirror、HTTP(S) proxy 和 `docker login` 继续负责镜像获取；拉取失败时输出针对官方源、国内镜像加速器和代理的排查建议。生产 Compose 的 `JUDGE_IMAGE_BASE` 继续控制评测镜像白名单前缀。

## Risks / Trade-offs

- [生产主机依赖 Docker Compose v2] → 启动前执行 `docker compose version` 检查并给出安装提示。
- [自动生成密钥后用户无法从输出恢复] → 仅生成并写入权限为 600 的 `.env.prod`，脚本不覆盖该文件；管理员密码不自动生成，要求用户明确填写。
- [镜像拉取可能耗时或受网络限制] → 将拉取作为独立可见阶段，失败时保留已有服务和数据，并提示代理/镜像源排查方向。
- [Compose healthcheck 不一定代表外部 TLS 已配置] → 脚本只检查容器服务健康，并明确提示外部 TLS 终止和域名解析仍需用户配置。
- [数据库备份不是完整灾备] → `backup` 明确只覆盖 PostgreSQL，并在文档中链接 #326 和完整备份 Runbook。

## Migration Plan

1. 用户将脚本随仓库获取，在填写 `.env.prod` 后执行 `install`。
2. 现有手工部署无需迁移；脚本使用相同的 Compose 文件、环境变量和数据卷。
3. 若脚本执行失败，可继续使用文档中的原始 Compose 命令排查；不会执行 `down -v` 或删除数据。
4. 升级前可执行 `backup`，升级失败时把 `NOJ_VERSION` 改回上一版本后执行 `upgrade`。
