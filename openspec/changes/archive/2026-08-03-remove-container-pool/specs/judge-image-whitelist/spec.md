## MODIFIED Requirements

### Requirement: get_image_allowlist RPC 响应升级

系统 SHALL 在 `get_image_allowlist` RPC 响应中返回每条镜像的 `kind` 字段（结构保留，
供未来消费者区分 Evaluator / Solution 用途）。judge 已不再于启动时拉取该响应预热
容器池，当前无分池消费方。

#### Scenario: RPC 响应包含 kind

- **WHEN** 调用方发送 `get_image_allowlist` RPC 请求
- **THEN** core 查询 `judge_images` 表中所有记录
- **THEN** core 返回 JSON 数组，每项包含 `image`、`kind`（`evaluator` / `solution`）、`mode`（`exact` / `all_versions`）
