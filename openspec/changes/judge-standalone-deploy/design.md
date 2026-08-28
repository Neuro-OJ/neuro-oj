## Context

当前生产 Compose 将 core、UI、Judge 和基础设施编排在同一份项目中。虽然现有文档
已经规定 Judge 必须使用专用 rootless Docker daemon，但独立评测节点仍需要手工复制
镜像配置、Redis 参数和 socket 权限，容易导致 Worker 连错队列或误用宿主机
`/var/run/docker.sock`。PR #374 只回滚了原有的整套下载部署入口，没有提供独立 Judge
部署能力，因此本变更从 `main` 单独实现一条可审计的 Linux Worker 路径。

## Goals / Non-Goals

### Goals

- 通过单个 Bash 入口完成 Judge 部署所需的下载、检测、配置和生命周期管理。
- 支持 core 与 Judge 分机部署，使用外部 Redis 和现有队列名称。
- 默认只接受专用 Unix Docker socket，并在启动前校验 socket 权限与镜像架构。
- 保留配置和缓存，支持安全重复启动与版本升级。
- 为交互式人工部署和自动化非交互部署提供同一套校验逻辑。

### Non-Goals

- 不改变 noj-judge Rust 代码、Redis 消息格式、core API 或评测协议。
- 不默认安装 Docker、不替换系统 Docker daemon、不自动创建 rootless daemon，避免
  脚本在未知主机上修改权限、subuid/subgid 或 systemd 用户服务。
- 不提供将应用宿主机 `/var/run/docker.sock` 代理给 Worker 的兼容模式。
- 不在本变更中增加 ARM64 发布镜像；脚本只负责在启动前给出明确架构提示。

## Decisions

### 1. 使用独立 Compose 项目运行发布镜像

脚本生成最小的 Judge Compose 文件，默认运行
`ghcr.io/neuro-oj/noj-judge:${NOJ_VERSION}`，而不是在目标机编译 Rust。这样部署
机器只需要 Docker、Compose 和专用 socket，升级只需替换镜像版本。Compose project
name 固定为 `noj-judge-standalone`，避免 `down` 或状态操作影响其他项目。

### 2. Redis 作为唯一外部业务依赖

配置使用完整的 `REDIS_URL`，不绑定 Compose 内部的 Redis 服务名。任务队列、结果
队列和必要的 Judge 运行参数显式写入配置文件，以确保独立节点能与 core 对接。脚本
只做连通性探测，不尝试初始化或清空 Redis。

### 3. 默认要求预先准备隔离 socket

脚本检查专用 Unix socket 的存在、类型和 GID，并把它只读挂载到 Worker。对于
`/var/run/docker.sock`、`/run/docker.sock`、TCP 和 HTTP endpoint 直接失败。rootless
daemon 的创建涉及发行版包、用户会话、subuid/subgid 和 systemd，脚本只输出针对性
引导，避免把高权限主机变更隐藏在“一键”命令中。

### 4. 配置文件严格收敛权限

配置文件使用 `0600`，交互式秘密输入关闭回显；状态和日志只展示脱敏摘要。脚本
不把 Redis 密码或 Registry 凭据拼接到命令输出中，也不把配置复制到镜像或评测
容器的工作目录。

### 5. 分层检查镜像架构

脚本优先用 Docker manifest 检查目标 Worker 镜像是否包含当前架构；无法访问 registry
时保留 Docker pull 的真实错误，并提示网络、认证或架构问题。当前 Release 工作流
发布 `linux/amd64`，因此 ARM64 主机在可确认时应在启动前失败，而不是创建重启循环。

### 6. 下载入口与部署入口分离

远程 `install.sh` 只负责安全下载指定 ref 的仓库归档并转交给本地 Judge 入口；
`--download-only` 不执行 Docker 操作。这样用户可以审阅下载内容、固定 ref 后再
部署，也能在没有完整源码 checkout 的机器上使用脚本。

## Risks / Tradeoffs

| 风险 | 取舍与缓解 |
| --- | --- |
| 目标主机没有隔离 rootless daemon | 安全优先，安装前明确失败并给出准备步骤；不回退到宿主机 socket |
| 外部 Redis 延迟或 TLS/认证配置错误 | 安装前做连接检查，失败时不启动；不修改 Redis 数据 |
| GHCR 无法访问或架构不匹配 | 启动前做 manifest/pull 检查，输出版本和架构提示 |
| 低配评测节点资源不足 | 检查磁盘/内存，默认并发保持与现有 Judge 一致，允许用户调整 |
| Compose 环境变量包含特殊字符 | 使用独立 env 文件和生成的 Compose 配置，状态输出脱敏 |
| 一键脚本权限过大 | 不自动安装/替换 Docker，不删除数据，不接受共享 host socket |

## Migration

现有整套生产部署不需要迁移。新增脚本默认写入用户指定的独立目录，并使用不同的
Compose project name。迁移现有 Worker 时，运维人员先为新节点准备同一 Redis、队列和
镜像白名单，再启动独立 Worker，确认无害样例评测成功后停止旧 Worker。回滚只需将
`NOJ_VERSION` 改回上一个 Release 并执行升级，不触碰 core 数据库或 Redis 队列。

## Open Questions

- ARM64 发布镜像是否要在单独变更中扩展 `.github/workflows/release.yml` 的 platforms；
  本变更不提前假设该发布策略。
- 是否需要为 rootless daemon 提供发行版专属安装向导；本变更先保留明确检测和文档
  指引，避免覆盖不同发行版的系统管理策略。
