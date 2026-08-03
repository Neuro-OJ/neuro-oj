## MODIFIED Requirements

### Requirement: 获取镜像白名单

系统 SHALL 支持通过 Redis RPC 从 core 获取允许使用的评测镜像列表（core 侧查询能力
保留）。judge 启动不再调用该 RPC：容器池已移除，无镜像预热消费方。

#### Scenario: 成功获取

- **WHEN** 调用方发送 `get_image_allowlist` RPC 请求
- **THEN** core 查询 `judge_images` 表中所有记录
- **THEN** core 返回 JSON 数组，每项包含 `image`（镜像名）、`kind`（`evaluator` /
  `solution`）和 `mode`（`exact` 或 `all_versions`）

#### Scenario: RPC 超时或不可用

- **WHEN** 调用方向 core 发起的 `get_image_allowlist` 请求超时或连接失败
- **THEN** 调用方记录错误日志并按自身策略处理（当前 judge 启动流程不依赖该 RPC）
