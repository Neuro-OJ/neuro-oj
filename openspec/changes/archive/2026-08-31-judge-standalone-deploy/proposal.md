## Why

当前生产部署脚本默认将 `noj-judge` 与 core、UI 一起启动，评测节点无法在没有完整应用仓库的机器上独立扩容。Judge 还需要 Redis 连接、Docker API 和独立的 rootless Docker socket，手工配置容易误挂载宿主机 socket，阻断评测隔离。

## What Changes

- 新增可独立下载的 Linux Judge 部署入口，支持固定 Release ref、目标目录和下载后执行。
- 增加 Judge 主机环境检测：Linux、CPU 架构、Docker daemon、Compose、Redis 连通性、独立 Docker socket、磁盘和内存。
- 增加交互式配置引导，填写 Redis、队列、工作目录、并发数和独立 Docker socket。
- 检测并引导用户准备独立 rootless Docker daemon；默认不替换现有 Docker daemon，避免
  未经确认修改宿主机权限和 systemd 配置。
- 提供独立 Docker Compose 项目的启动、停止、状态、日志和升级入口。
- 拒绝使用 `/var/run/docker.sock` 作为 Judge 沙箱 socket，并保留非交互模式供自动化部署。
- 增加离线 smoke test、Linux VM 验证说明和故障排查文档。

## Capabilities

### New Capabilities

- `judge-standalone-deploy`: 独立 Judge Worker 的下载、配置、环境检测和服务生命周期管理。

### Modified Capabilities

无。独立部署脚本复用现有 Judge 的 Docker 隔离契约，不改变评测协议或运行时安全规则。

## Impact

- 影响 `scripts/deploy/`、Judge 运维文档和部署脚本测试；不修改 Judge 镜像构建流程。
- 不修改 core API、Redis 消息格式或 Judge 评测协议。
- 目标主机仍需要预先创建只服务于 Judge 的 rootless Docker daemon；脚本负责检测、提示和
  校验，不默认自动修改宿主机 systemd、subuid/subgid 或 Docker 运行时权限。
