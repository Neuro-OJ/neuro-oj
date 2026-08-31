## Why

独立 Judge 首次部署时，用户往往不知道 Redis 是什么、应该连接哪一个实例，手动填写
地址容易导致 Judge 连接到错误的 Redis，最终无法收到评测任务。部署脚本应在不破坏
现有服务的前提下，帮助用户选择已有 Redis，或创建一个明确标注用途的本机 Redis。

## What Changes

- 在 Judge 配置向导中增加 Redis 来源选择：连接已有 Redis、创建本机 Redis、稍后配置。
- 连接已有 Redis 时，提示 Redis URL 示例并自动执行连通性检查。
- 创建本机 Redis 时，使用 Docker 创建持久化实例和随机密码，不覆盖已有容器或端口。
- 创建成功后生成可复制的 Redis 连接信息，并明确说明 noj-core 必须使用同一个 Redis。
- 非交互模式继续要求通过环境变量提供 `REDIS_URL`，不会静默创建 Redis。
- 增加创建、复用、冲突和密码脱敏测试。

## Capabilities

### New Capabilities

- `judge-redis-setup`: 独立 Judge 部署时 Redis 的连接、可选创建和安全校验。

### Modified Capabilities

无。

## Impact

- 影响 `scripts/deploy/judge-install.sh` 和对应测试脚本。
- 可能创建一个命名 Docker 容器和持久化卷，但不安装、替换或修改宿主机 Docker daemon。
- 不修改 Redis 消息格式；Judge 仍必须与 noj-core 使用相同的 Redis、数据库和队列名称。
- 不新增应用依赖，使用现有 Docker CLI 和 Redis 镜像。
