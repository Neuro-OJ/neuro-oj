# judge-redis-setup Specification

## Purpose

让独立 Judge 部署用户能够理解 Redis 的用途、连接已有 Redis，或在明确风险和连接方式的情况下创建本机 Redis，避免 Judge 部署成功但无法收到评测任务。

## Requirements

### Requirement: Guided Redis source selection

首次交互式部署 MUST 在配置 Redis 前说明 Redis 是 noj-core 与 Judge 之间的任务中转服务，并提供连接已有 Redis、创建本机 Redis 和稍后配置三个选项。默认选项 MUST 是连接已有 Redis；非交互式部署 MUST 不因缺少 `REDIS_URL` 而静默创建 Redis。

#### Scenario: Connect an existing Redis

- **WHEN** 用户选择连接已有 Redis
- **THEN** 脚本提示完整 `redis://`/`rediss://` URL，给出无密码和有密码示例，并在启动前验证连通性

#### Scenario: Defer Redis configuration

- **WHEN** 用户选择稍后配置
- **THEN** 脚本不创建 Redis、不启动 Judge，并说明需要配置与 noj-core 相同的 Redis URL 后重新执行

### Requirement: Create a local Redis safely

用户明确选择创建本机 Redis 时，脚本 MUST 使用现有 Docker CLI 创建带持久化数据卷、随机密码、固定管理标签和非冲突端口的 Redis 容器。脚本 MUST 拒绝覆盖同名的非本工具容器或占用的端口，并且不得安装、替换或修改宿主机 Docker daemon。

#### Scenario: Local Redis is created

- **WHEN** 用户选择创建本机 Redis 且容器名与端口均可用
- **THEN** 脚本创建 Redis 容器和持久化卷，生成仅属主可读的配置，并输出供 noj-core 使用的连接信息

#### Scenario: Existing container name conflicts

- **WHEN** 目标容器名已被非本工具容器占用
- **THEN** 脚本失败并要求用户连接已有 Redis 或更换 Redis 容器名，不删除或修改原容器

#### Scenario: Redis port conflicts

- **WHEN** 用户选择的本机 Redis 端口无法绑定
- **THEN** 脚本在启动 Judge 前失败，并保留清晰的端口冲突修复提示

### Requirement: Redis connection contract and secret handling

无论 Redis 来源如何，Judge MUST 使用与 noj-core 相同的 Redis 实例、数据库、认证信息、任务队列和结果队列。Redis 密码 MUST 不出现在提示、命令日志、状态摘要或错误输出中；本机 Redis 的密码和配置文件 MUST 使用仅属主可读权限保存。

#### Scenario: Local Redis connection is explained

- **WHEN** 本机 Redis 创建成功
- **THEN** 脚本同时说明 Judge 使用的连接地址与 noj-core 应使用同一实例，并提示用户不要将两个服务配置到不同 Redis

#### Scenario: Redis check fails

- **WHEN** Redis 地址不可连接或认证失败
- **THEN** 脚本在启动 Judge 前退出，显示脱敏的 Redis 主机信息和修复方向，不显示密码
