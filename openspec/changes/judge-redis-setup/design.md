## Context

当前独立 Judge 脚本要求用户直接填写 `REDIS_URL`，虽然会做连通性检查，但首次部署用户
通常不知道 Redis 的用途以及应该连接 core 使用的哪一个实例。变更必须保持 Judge 的
rootless Docker socket 安全边界，并避免把新建 Redis 误认为已经接入 noj-core。

## Goals / Non-Goals

**Goals:**

- 在首次配置中解释 Redis 与评测队列的关系，并提供已有 Redis 的连接引导。
- 在用户明确选择时创建一个可持久化、带随机密码的本机 Redis。
- 对容器名、端口、配置权限和密码输出进行安全校验。
- 让 Judge 容器能够访问本机创建的 Redis，同时保留给 core 使用的连接信息。

**Non-Goals:**

- 不自动修改 noj-core 的 `.env` 或生产 Redis 配置。
- 不将本机 Redis 默认暴露到公网。
- 不自动安装或修改 Docker daemon、systemd、网络防火墙或 rootless 配置。
- 不在非交互模式下创建 Redis。

## Decisions

1. **已有 Redis 为默认路径。**
   这是生产部署中最安全、最符合 core/judge 队列契约的选择。向导使用完整 Redis URL，
   密码输入隐藏；使用单独的校验 URL 处理本机容器地址与 Judge 容器访问地址的差异。

2. **本机 Redis 使用显式 Docker 容器。**
   创建 `redis:7-alpine` 容器、命名 Docker volume、随机密码和仅绑定到回环地址的端口。
   使用配置文件挂载 `requirepass`，避免把密码放进 `docker run` 命令参数；容器带固定管理
   label，遇到同名容器时先检查归属，非本工具容器一律拒绝覆盖。

3. **本机 Redis 与 Judge 通过 host-gateway 连接。**
   Redis 在宿主机回环端口监听；Judge Compose 增加 `host.docker.internal:host-gateway`
   映射，并将容器内运行地址与宿主机/core 使用的地址分别保存。这样不需要把 Redis 加入
   Judge 的沙箱网络，也不要求修改 core 的 Compose 网络。

4. **密码脱敏贯穿检查和日志。**
   Redis 连通性检查使用临时、仅属主可读的 env 文件传给临时 Redis 客户端，避免密码出现在
   Docker 命令行和测试日志中；临时文件在成功或失败后删除。

## Risks / Trade-offs

- [本机 Redis 仍需 core 使用同一连接信息] → 创建完成后同时打印 core 使用地址，并在文档中明确说明；不自动修改 core 配置。
- [host-gateway 依赖现代 Docker] → 在环境预检中要求 Docker Compose 可用，启动前通过 Compose 配置和 Redis PING 检查暴露错误。
- [回环端口可能已被占用] → 创建前检查端口，且保留 Docker 的失败信息；不停止或删除已有服务。
- [随机密码需要持久化保存] → Redis 配置和 Judge env 文件均设置为 `0600`，状态和错误输出只显示主机与端口。

## Migration Plan

已有 `.env.judge` 的部署不触发 Redis 来源选择，继续使用现有 `REDIS_URL`。新用户可选择连接
已有 Redis；选择创建本机 Redis 后，按脚本输出的地址配置 core，再重新执行部署检查。

回滚时停止 Judge 即可；本机 Redis 容器和数据卷由用户显式保留或按 Docker 管理命令单独处理，
脚本不提供隐式删除动作。
