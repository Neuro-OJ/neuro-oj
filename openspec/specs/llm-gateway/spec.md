## Purpose

定义 Neuro OJ LLM 网关（noj-llm-gateway）规范，覆盖 Provider 管理、eval_token 签发与校验、OpenAI 兼容代理、限流额度、用量审计与服务间安全。

## Requirements

### Requirement: Provider 管理

系统 SHALL 提供 LLM Provider 管理能力，管理员可创建、更新、启停、删除上游 OpenAI 兼容 Provider。Provider 配置 MUST 包含 `base_url`、默认 `model`、`encrypted_api_key`、`enabled` 等字段；真实 API Key MUST 使用 `NOJ_LLM_STORE_KEY` 信封加密后存储，任何查询接口 MUST NOT 返回明文 Key。

#### Scenario: 管理员创建 Provider

- **WHEN** 管理员调用 Provider 创建 API，提交合法 `base_url`、`model`、`api_key`
- **THEN** 系统使用 AES-256-GCM 加密 `api_key` 后写入 `llm_providers`
- **THEN** 创建成功，响应不包含明文 `api_key`

#### Scenario: 查询 Provider 列表不泄露 Key

- **WHEN** 管理员查询 Provider 列表或详情
- **THEN** 响应仅包含脱敏 Key（如 `sk-****last4`），不包含明文或可解密内容

#### Scenario: 停用 Provider

- **WHEN** 管理员将 Provider 的 `enabled` 设为 false
- **THEN** 该 Provider 不再被任何新评测任务选用；已签发的 token 校验时同样拒绝使用该 Provider

### Requirement: eval_token 签发与校验

系统 SHALL 使用 AEAD（AES-256-GCM）签发自包含 `eval_token`，由 noj-core 与 noj-llm-gateway 共享 `NOJ_LLM_SERVICE_TOKEN`。token 载荷 MUST 包含 `jti`、`submission_id`、`problem_id`、`user_id`、`provider_id`、`allowed_models`、`iat`、`exp`、`max_calls`、`max_tokens`。token TTL MUST 为题目 evaluator `Time Limit × 4`；重测 MUST 重新签发新 token。

#### Scenario: 签发 token

- **WHEN** noj-core 为一次提交构造评测任务
- **THEN** 使用共享密钥签发 AEAD token，明文 token 仅返回给 noj-core，gateway 不落库存储 token

#### Scenario: 校验 token 通过

- **WHEN** evaluator 携带合法且未过期的 token 调用 gateway
- **THEN** gateway 解密并校验 AEAD tag、`exp`、`provider_id`、`allowed_models`
- **THEN** 校验通过后继续代理转发

#### Scenario: 校验 token 失败

- **WHEN** evaluator 携带伪造、篡改、过期或不在允许模型范围内的 token
- **THEN** gateway 返回 401/403，不转发上游请求

#### Scenario: 重测重新签发

- **WHEN** 同一提交被重测（rejudge）
- **THEN** noj-core 重新签发新的 `eval_token`，旧 token 不主动撤销但会在 `Time Limit × 4` 后过期

### Requirement: OpenAI 兼容代理

系统 SHALL 暴露 OpenAI 兼容的 `POST /v1/chat/completions` 接口。请求 MUST 使用 `Authorization: Bearer <eval_token>` 鉴权；gateway 校验 token 后，使用对应 Provider 的真实 Key 将请求转发到上游，并将上游响应原样返回。

#### Scenario: 正常转发

- **WHEN** evaluator 发送合法 Chat Completions 请求
- **THEN** gateway 校验 token、检查限流/额度后转发到对应 Provider
- **THEN** 返回上游的标准 OpenAI 格式响应

#### Scenario: 上游错误透传

- **WHEN** 上游返回 4xx/5xx 或超时
- **THEN** gateway 记录错误并返回标准化错误响应，同时记录 `status`/`error_code` 到用量审计

### Requirement: 限流与额度

系统 SHALL 在 Redis 中维护不可替代的累计状态：单次提交、用户时间窗、全局时间窗、题目时间窗的调用次数/token/费用，以及用户/IP 速率窗口。每次转发前 MUST 依次检查这些限额，任一超限 MUST 拒绝请求。

#### Scenario: 单次提交超限

- **WHEN** 当前 `submission_id` 已使用次数/token/费用达到 token 载荷或配额上限
- **THEN** gateway 拒绝该次调用并返回 429

#### Scenario: 用户日额度超限

- **WHEN** 当前用户当日累计调用量超过配置的用户日额度
- **THEN** gateway 拒绝该次调用并返回 429

#### Scenario: 全局额度超限

- **WHEN** 当前实例当日总用量超过全局额度
- **THEN** gateway 拒绝该次调用并返回 429

#### Scenario: 速率窗口超限

- **WHEN** 用户或 IP 在窗口内请求频率超过速率限制
- **THEN** gateway 拒绝该次调用并返回 429

### Requirement: 用量审计

系统 SHALL 将每次代理请求写入 `llm_usage` 表，包含 `submission_id`、`problem_id`、`user_id`、`provider_id`、`model`、完整原始 `request_messages` JSON、`request_params`、`prompt_tokens`、`completion_tokens`、`total_tokens`、`estimated_cost`、`latency_ms`、`status`、`error_code`、`prompt_hash`、`created_at`。审计数据 MUST 始终保留，不自动清理。

#### Scenario: 记录成功调用

- **WHEN** 一次 LLM 代理调用成功
- **THEN** `llm_usage` 新增一条记录，包含完整请求消息与 token/费用统计

#### Scenario: 记录失败调用

- **WHEN** 一次 LLM 代理调用因上游错误、超时或限流失败
- **THEN** `llm_usage` 仍记录该次尝试，`status`/`error_code` 标记失败原因

#### Scenario: 审计数据不自动删除

- **WHEN** 系统运行任意时长
- **THEN** `llm_usage` 数据不被自动清理，除非管理员显式执行删除/归档操作

### Requirement: 服务间安全

系统 SHALL 要求 noj-core 与 noj-llm-gateway 的管理 API 使用 `NOJ_LLM_SERVICE_TOKEN` 鉴权。真实上游 API Key MUST 只存在于 gateway 的加密存储与内存中，MUST NOT 进入 evaluator 容器、日志或提交代码。

#### Scenario: 管理 API 鉴权

- **WHEN** noj-core 调用 gateway 管理 API（Provider 配置、用量查询等）
- **THEN** 请求必须携带 `NOJ_LLM_SERVICE_TOKEN`，缺失或错误返回 401

#### Scenario: Key 不进入 evaluator

- **WHEN** 评测任务下发到 evaluator
- **THEN** evaluator 环境变量只包含 `NOJ_LLM_GATEWAY_URL`、`NOJ_LLM_TOKEN`、`NOJ_LLM_PROVIDER_ID`、`NOJ_LLM_ALLOWED_MODELS`
- **THEN** 不包含任何上游真实 API Key
