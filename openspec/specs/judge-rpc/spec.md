## Purpose

定义 noj-core 与 noj-judge 之间的 Redis RPC 通信协议。支持 judge 启动时从 core 获取镜像白名单、健康检查等双向通信需求。

## Requirements

### Requirement: Redis RPC 通信协议

系统 SHALL 定义 core↔judge 之间的 Redis 双向请求/响应通信协议。

#### Scenario: 消息命名空间

- **WHEN** judge 向 core 发起 RPC 请求
- **THEN** 请求消息写入 List `noj:rpc:v1:judge:core`
- **WHEN** core 向 judge 返回 RPC 响应
- **THEN** 响应消息写入 List `noj:rpc:v1:judge:{judge_id}:response`
- **WHEN** core 向 judge 发起 RPC 请求
- **THEN** 请求消息写入 List `noj:rpc:v1:core:judge`
- **WHEN** judge 向 core 返回 RPC 响应
- **THEN** 响应消息写入 List `noj:rpc:v1:core:response`

#### Scenario: Judge ID 确定

- **WHEN** judge 启动时初始化 RPC 客户端
- **THEN** 若 `JUDGE_ID` 环境变量存在，使用该值作为 judge_id
- **THEN** 若 `JUDGE_ID` 不存在，使用 `gethostname::gethostname()` 的返回值
- **THEN** judge_id 在本次运行期间保持不变

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
- **THEN** 请求超时退出，调用方按自身策略处理错误（如 fail-fast 退出）

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
