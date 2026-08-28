## 1. 部署入口与配置

- [x] 1.1 新增独立 Judge Linux 部署脚本，支持下载指定仓库 ref、目标目录、`--download-only` 和安全的重复执行，并用离线测试验证不会覆盖既有配置
- [x] 1.2 实现交互式与非交互式配置生成，覆盖版本、Redis、队列、工作目录、并发、镜像前缀、专用 Docker socket 和 socket GID，并验证配置文件权限为 `0600` 且敏感值不出现在输出中
- [x] 1.3 生成最小化的独立 Compose 配置，固定 project name、非 root Worker、只读专用 socket 挂载、缓存卷和现有 Judge 安全环境变量，并用 `docker compose config` 验证渲染结果

## 2. 环境检查与生命周期

- [x] 2.1 实现 Linux、架构、Docker daemon、Docker Compose、资源、目录权限和专用 Unix socket 检查，并验证缺失依赖或共享 host socket 会在启动前失败
- [x] 2.2 实现 Redis 连通性与 Worker 镜像架构检查，验证 ARM64/无 manifest 场景给出可操作提示且不创建重启循环
- [x] 2.3 实现 `install`、`start`、`stop`、`status`、`logs` 和 `upgrade`，验证重复启动幂等、停止保留配置/缓存、升级保留配置且失败返回非零状态

## 3. 文档与回归验证

- [x] 3.1 更新部署脚本索引和 Judge 运维文档，说明独立节点、Redis/队列契约、rootless socket 准备、架构限制、首次 smoke test、升级和回滚
- [x] 3.2 新增不依赖真实生产资源的脚本测试，覆盖帮助、下载模式、配置脱敏、参数校验、共享 socket 拒绝和生命周期命令调用
- [x] 3.3 运行 Shell 静态检查、脚本测试、OpenSpec 严格校验和相关 Rust/Compose 校验，并记录 Debian/Ubuntu 虚拟机上的可执行性结果
