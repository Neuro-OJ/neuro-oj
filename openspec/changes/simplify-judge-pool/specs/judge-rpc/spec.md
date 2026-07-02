## ADDED Requirements

### Requirement: Redis RPC 通信协议

系统 SHALL 定义 core↔judge 之间的 Redis 双向请求/响应通信协议。

#### Scenario: 消息命名空间

- **WHEN** judge 向 core 发起 RPC 请求
- **THEN** 请求消息写入 List `noj:rpc:v1:judge:core`
- **WHEN** core 向 judge 返回 RPC 响应
- **THEN** 响应消息写入 List `noj:rpc:v1:judge:{judge_id}:response`（`judge_id` 为 judge 实例标识）
- **WHEN** core 向 judge 发起 RPC 请求
- **THEN** 请求消息写入 List `noj:rpc:v1:core:judge`
- **WHEN** judge 向 core 返回 RPC 响应
- **THEN** 响应消息写入 List `noj:rpc:v1:core:response`

#### Scenario: 消息信封格式

- **WHEN** 任何一方发送 RPC 请求
- **THEN** 消息 JSON 包含字段：`id`（UUID）、`method`（字符串）、`params`（可选 JSON）、`timestamp`（整数 Unix 时间戳）
- **WHEN** 任何一方发送 RPC 响应
- **THEN** 消息 JSON 包含字段：`id`（对应请求的 UUID）、`result`（可选 JSON）、`error`（可选字符串）、`timestamp`

#### Scenario: 请求/响应关联

- **WHEN** 请求方发送消息
- **THEN** 将 `id` 设为新生成的 UUID v4
- **WHEN** 响应方处理完成后
- **THEN** 回复消息的 `id` 与请求消息的 `id` 一致，确保请求方能关联到正确的响应

#### Scenario: 请求超时

- **WHEN** 请求方发送请求后未在超时窗口内收到响应
- **THEN** 请求超时退出，调用方按自身策略处理退化逻辑

### Requirement: 获取镜像白名单

系统 SHALL 支持 judge 通过 Redis RPC 从 core 获取允许使用的评测镜像列表。

#### Scenario: 成功获取

- **WHEN** judge 发送 `get_image_allowlist` RPC 请求
- **THEN** core 查询 `judge_images` 表中所有 `enabled = true` 的记录
- **THEN** core 返回 JSON 数组，每项包含 `image`（镜像名）和 `tag`（标签）
- **THEN** judge 使用返回的镜像列表预热容器池

#### Scenario: RPC 超时或不可用

- **WHEN** judge 向 core 发起的 `get_image_allowlist` 请求超时或连接失败
- **THEN** judge 记录 `error!` 日志并调用 `process::exit(1)` 退出
- **THEN** 由外部进程管理器（systemd / docker-compose / k8s）重启 judge

## MODIFIED Requirements

### Requirement: 统一容器池管理

[见 container-pool spec — 启动时创建初始池场景更新为从 Redis RPC 获取镜像列表]

#### Scenario: 启动时创建初始池

- **WHEN** noj-judge 启动
- **THEN** 系统先通过 Redis RPC 向 core 请求镜像白名单
- **THEN** 若 RPC 成功，使用返回的镜像列表替代（叠加）`POOL_IMAGES` 环境变量
- **THEN** 若 RPC 失败或返回空列表，退化到 `POOL_IMAGES` 环境变量
- **THEN** 对每个镜像拉取或确认本地存在（失败重试 3 次，间隔 5s）
- **THEN** 每个镜像创建 `POOL_INITIAL_SIZE` 个预热容器，CMD 设为 `sleep infinity`
- **THEN** 容器全部就绪后，主循环开始从 MQ 拉取任务

## REMOVED Requirements

<!-- None — Redis RPC is new, not removing anything -->
