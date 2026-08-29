## Purpose

定义 Neuro OJ 管理端 LLM 网关控制台规范，包括 Provider 配置管理、用量查询与导出能力。

## Requirements

### Requirement: Provider 管理 UI

系统 SHALL 提供管理端 Provider 配置页面，支持管理员查看 Provider 列表、创建 Provider、编辑 `base_url`/默认 `model`/`enabled`、更新 API Key、停用/启用 Provider。页面 MUST NOT 展示明文 API Key，只展示脱敏信息。

#### Scenario: 查看 Provider 列表

- **WHEN** 管理员打开 LLM Provider 管理页
- **THEN** 页面展示 Provider 名称、`base_url`、默认模型、状态、脱敏 Key，不展示明文 Key

#### Scenario: 创建 Provider

- **WHEN** 管理员填写 `base_url`、`model`、`api_key` 并提交
- **THEN** 系统创建 Provider，页面提示创建成功

#### Scenario: 更新 API Key

- **WHEN** 管理员为已有 Provider 输入新的 `api_key`
- **THEN** 系统加密更新 Key，且不在页面回显明文

#### Scenario: 停用 Provider

- **WHEN** 管理员将 Provider 状态切换为停用
- **THEN** 该 Provider 不再用于新评测

### Requirement: 用量查询 UI

系统 SHALL 提供 LLM 用量查询页面，支持按时间范围、用户、题目、Provider、状态筛选调用记录，并展示调用次数、token 用量、估算费用、成功率等聚合指标。页面数据 MUST 来自 `llm_usage` 审计表。

#### Scenario: 查询全部用量

- **WHEN** 管理员打开用量查询页并选择时间范围
- **THEN** 页面展示该时间范围内的调用次数、总 token、总费用、状态分布

#### Scenario: 按用户筛选

- **WHEN** 管理员输入或选择用户 ID/用户名进行筛选
- **THEN** 页面只展示该用户的 LLM 调用记录与聚合用量

#### Scenario: 查看单次调用详情

- **WHEN** 管理员点击一条用量记录
- **THEN** 页面展示该次调用的 `submission_id`、`problem_id`、`user_id`、`provider_id`、`model`、token、费用、耗时、状态及完整 `request_messages`

### Requirement: 用量导出

系统 SHALL 支持将用量查询结果导出为 CSV（或 JSON），导出内容与当前筛选条件一致，且不包含上游 API Key 等敏感凭据。

#### Scenario: 导出 CSV

- **WHEN** 管理员在用量查询页点击导出
- **THEN** 系统生成 CSV 文件，包含当前筛选条件下的用量记录
- **THEN** 文件不包含任何明文 API Key 或 `NOJ_LLM_TOKEN`
