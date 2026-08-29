## Purpose

为没有完整 Neuro OJ 应用仓库的 Linux 评测节点提供可重复的 noj-judge 独立部署入口，
让运维人员能够完成版本下载、环境检查、配置生成和 Worker 生命周期管理，同时保持
现有 Redis 队列协议与 Docker 沙箱安全边界不变。

## ADDED Requirements

### Requirement: Standalone Linux entrypoint

部署入口 MUST 支持从仓库下载指定 ref 的部署脚本或归档，并在目标目录生成仅供
noj-judge 使用的运行文件。入口 MUST 支持显式指定仓库、ref 和目标目录；重复执行
不得覆盖用户现有的配置文件或运行数据，除非用户显式请求升级。

#### Scenario: Download only the entrypoint

- **WHEN** 用户通过远程脚本请求下载模式并指定目标目录
- **THEN** 脚本只下载并校验部署内容，不启动服务、不修改 Docker daemon，也不写入
  目标目录之外的文件

#### Scenario: Upgrade an existing worker

- **WHEN** 目标目录已有配置且用户执行升级
- **THEN** 脚本保留配置和缓存数据，更新 Worker 镜像版本或运行文件，并在启动前
  显示将要使用的版本

#### Scenario: Unsafe target is rejected

- **WHEN** 目标目录不是空目录且用户未选择升级或覆盖配置
- **THEN** 脚本终止并说明如何显式继续，不删除目录中的文件

### Requirement: Environment detection before deployment

部署入口 MUST 在启动前检查 Linux 系统、受支持的 CPU 架构、Docker daemon、Docker
Compose、目标工作目录权限、可用磁盘和内存。脚本 MUST 检查配置的 Redis 地址是否可
连通，并检查配置的 Docker socket 存在、为 Unix socket 且不是 `/var/run/docker.sock`
或 `/run/docker.sock`。检查失败时 MUST 在启动 Worker 前退出并给出修复提示。

#### Scenario: Missing Docker tooling

- **WHEN** 目标机缺少 Docker daemon 或 Docker Compose
- **THEN** `check` 和部署命令报告缺失项，并且部署命令不拉起 Worker

#### Scenario: ARM64 image is unavailable

- **WHEN** 目标机架构为 `aarch64`/`arm64` 且所选 Worker 镜像没有对应架构
- **THEN** 脚本在启动前报告当前镜像架构限制和可选方案，不创建会持续重启的容器

#### Scenario: Shared host socket is selected

- **WHEN** 用户把 Judge Docker socket 配置为 `/var/run/docker.sock` 或 `/run/docker.sock`
- **THEN** 脚本拒绝配置，并要求用户提供专用 rootless Docker daemon 的 Unix socket

### Requirement: Guided and non-interactive configuration

首次部署 MUST 通过交互式提示引导用户填写 Worker 版本、Redis URL、任务队列、结果
队列、工作目录、并发数、镜像前缀、专用 Docker socket 和 socket GID。Redis URL 中
的密码、Registry token 等敏感值 MUST 使用隐藏输入或环境变量传入，不能回显到终端、
日志或测试输出。脚本 MUST 支持非交互模式，并在缺少必填项时失败且列出缺失配置。

#### Scenario: First install prompts for required values

- **WHEN** 用户在没有配置文件的目录执行安装
- **THEN** 脚本逐项提示必填配置，确认后以仅属主可读的权限写入配置文件

#### Scenario: Non-interactive install is complete

- **WHEN** 用户使用 `--non-interactive` 并提供全部必填环境变量
- **THEN** 脚本不读取终端输入，生成等价配置并继续执行环境检查

#### Scenario: Secret is not echoed

- **WHEN** 用户输入包含密码的 Redis URL 或 Registry 凭据
- **THEN** 终端输出、配置检查摘要和失败日志均不打印该秘密的原文

### Requirement: Isolated Docker endpoint contract

独立部署生成的 Worker 配置 MUST 启用 `JUDGE_REQUIRE_ISOLATED_DOCKER=true`，使用
专用 Unix Docker endpoint，并将该 endpoint 以只读 socket 挂载给非 root Worker。脚本
MUST 不自动挂载应用宿主机 Docker socket，不接受 TCP/HTTP Docker endpoint，也不得把
Redis、缓存或 Worker 配置写入 Judge 沙箱容器的宿主机敏感路径。

#### Scenario: Dedicated rootless socket is ready

- **WHEN** 配置的专用 Unix socket 存在且当前 Worker 用户可访问
- **THEN** 脚本通过 Compose 启动 Worker，并保留隔离模式配置

#### Scenario: Socket is missing or inaccessible

- **WHEN** 专用 socket 不存在、不是 socket 文件或 socket GID/权限不匹配
- **THEN** 脚本报告 rootless daemon 和组权限的修复方向，并在修复前不启动 Worker

### Requirement: Safe worker lifecycle

部署入口 MUST 提供 `install`、`start`、`stop`、`status`、`logs` 和 `upgrade` 操作，
并使用固定的 Compose project name 或等价唯一标识避免误操作其他应用。`stop` 和
`upgrade` MUST 保留 Redis 中的任务、配置文件及 Judge 缓存；脚本不得提供默认删除
持久化数据的清理动作。启动失败时 MUST 返回非零状态并保留日志供排查。

#### Scenario: Repeated start is idempotent

- **WHEN** Worker 已运行且用户再次执行 `start`
- **THEN** 脚本不创建重复项目，报告现有服务状态

#### Scenario: Status exposes readiness

- **WHEN** 用户执行 `status`
- **THEN** 脚本显示 Worker 容器状态、使用的版本、Redis/Compose 配置摘要和隔离
  socket 检查结果，但不显示秘密

#### Scenario: Stop preserves work

- **WHEN** 用户执行 `stop`
- **THEN** Worker 停止但配置、缓存和 Redis 中的任务不被删除

### Requirement: Deployment verification guidance

部署入口和运维文档 MUST 提供首次启动后的最小验证步骤，包括 Docker PING、Redis
队列连接、无害样例评测、日志和升级回滚检查。文档 MUST 明确说明独立 Judge 节点
仍需与 noj-core 使用同一个 Redis 和队列名称，并说明当前发布镜像不支持的架构。

#### Scenario: Operator verifies a new worker

- **WHEN** Worker 首次启动成功
- **THEN** 运维人员可以按文档检查隔离 socket、队列长度和一条无害评测结果，再
  扩容其他 Worker

#### Scenario: Operator diagnoses a failed check

- **WHEN** 环境检查或 Worker 启动失败
- **THEN** 文档能将问题归类到 Docker、Compose、Redis、socket 权限、镜像架构或
  队列配置，并给出下一步操作
