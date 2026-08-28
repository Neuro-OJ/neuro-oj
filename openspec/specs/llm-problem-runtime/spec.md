## Purpose

定义 Neuro OJ LLM 题目运行时规范，覆盖题目 LLM 元数据配置、准入、强制网络、JudgeTask 注入与 evaluator SDK 调用。

## Requirements

### Requirement: 题目 LLM 元数据配置

系统 SHALL 支持题目声明可选的 `llm` 配置，包含 `provider_id` 与 `model`。该配置 MUST 出现在 `problem.json` manifest 与题目 CRUD API 中，并落库到 `problems.llm_config` JSONB 列（可空）。出题人 MUST 固定 `provider_id` 与 `model`，做题人提交时不可选择或覆盖。

#### Scenario: 导入包声明 llm 配置

- **WHEN** 管理员导入 `problem.json`，其中包含合法 `llm: {"provider_id": "...", "model": "qwen-plus"}`
- **THEN** 系统校验通过并将 `llm_config` 写入题目记录

#### Scenario: 无 llm 配置

- **WHEN** 题目未声明 `llm`
- **THEN** `llm_config` 为 NULL，评测走普通双容器流程，不涉及 gateway

#### Scenario: 做题人不可覆盖模型

- **WHEN** 用户提交代码或调用接口时尝试指定 `model` 或 `provider_id`
- **THEN** 系统忽略或拒绝该尝试，评测始终使用题目固定的 `provider_id/model`

### Requirement: LLM 题目准入

系统 SHALL 仅允许管理员创建的 P 型/官方题或经过审核批准的题目启用 LLM 配置。普通用户创建的 U 型题默认 MUST NOT 启用 LLM；若未来开放 U 型题 LLM，必须先进入审核白名单。

#### Scenario: 管理员创建 P 型 LLM 题

- **WHEN** 管理员创建或更新 P 型题目并携带 `llm` 配置
- **THEN** 系统接受该配置

#### Scenario: 普通用户 U 型题启用 LLM 被拒

- **WHEN** 普通用户创建或更新 U 型题目并携带 `llm` 配置
- **THEN** 系统返回 403，提示仅受信题目可启用 LLM

#### Scenario: 未审核题目启用 LLM 被拒

- **WHEN** 题目不在管理员白名单/审核通过状态但携带 `llm` 配置
- **THEN** 系统返回 403

### Requirement: LLM 题目强制开启网络

系统 SHALL 要求启用 LLM 配置的题目必须同时设置 `runtime_config.evaluator.network.enabled = true`。创建、变更、导入接口 MUST 在服务端强制校验；不满足时返回 400，且前端编辑界面 MUST 显示提示。

#### Scenario: 创建时未开启网络

- **WHEN** 创建题目携带 `llm` 配置但 `runtime_config.evaluator.network.enabled` 缺失或为 false
- **THEN** 系统返回 400，提示必须启用 evaluator 网络

#### Scenario: 编辑时关闭网络

- **WHEN** 更新已启用 LLM 的题目，将 `runtime_config.evaluator.network.enabled` 改为 false
- **THEN** 系统返回 400，提示必须保持网络开启

#### Scenario: 前端提示

- **WHEN** 用户在编辑界面勾选或填写 LLM 配置
- **THEN** 界面显示“启用 LLM 调用必须开启 Evaluator 联网”的提示

### Requirement: JudgeTask.llm 字段与 evaluator 注入

系统 SHALL 在 `JudgeTask` 中新增 `llm` 字段，包含 `gateway_url`、`eval_token`、`provider_id`、`allowed_models`。noj-judge MUST 在启动 evaluator exec 时将这些值注入环境变量：`NOJ_LLM_GATEWAY_URL`、`NOJ_LLM_TOKEN`、`NOJ_LLM_PROVIDER_ID`、`NOJ_LLM_ALLOWED_MODELS`。Solution 容器 MUST NOT 获得这些值。

#### Scenario: 构造 LLM 评测任务

- **WHEN** noj-core 为启用 LLM 的题目创建 JudgeTask
- **THEN** JudgeTask 包含 `llm.gateway_url`、`llm.eval_token`、`llm.provider_id`、`llm.allowed_models`

#### Scenario: 注入 evaluator 环境

- **WHEN** noj-judge 启动 evaluator exec
- **THEN** evaluator 进程环境包含 `NOJ_LLM_GATEWAY_URL`、`NOJ_LLM_TOKEN`、`NOJ_LLM_PROVIDER_ID`、`NOJ_LLM_ALLOWED_MODELS`
- **THEN** solution 容器环境不包含任何 `NOJ_LLM_*` 变量

#### Scenario: 非 LLM 任务不注入

- **WHEN** JudgeTask 不包含 `llm` 字段
- **THEN** noj-judge 不注入任何 `NOJ_LLM_*` 环境变量

### Requirement: evaluator SDK llm 模块

系统 SHALL 在 `noj_evaluator_sdk` 提供 `llm` 模块，封装对 gateway 的 OpenAI 兼容调用。SDK MUST 自动从环境变量读取 gateway 地址与 token，提供 `llm.complete(model=..., messages=..., **params)` 等高层 API。

#### Scenario: SDK 调用成功

- **WHEN** evaluator 调用 `llm.complete(...)`
- **THEN** SDK 向 gateway 发送携带 `NOJ_LLM_TOKEN` 的 Chat Completions 请求并返回解析结果

#### Scenario: 缺少环境变量

- **WHEN** evaluator 调用 `llm.complete(...)` 但环境变量缺失
- **THEN** SDK 抛出明确的配置错误，提示未配置 LLM gateway

### Requirement: 重测重新签发

系统 SHALL 在每次重测（rejudge）时为同一提交重新签发新的 `eval_token`，避免与旧 token 的过期时间冲突。

#### Scenario: 重测签发新 token

- **WHEN** 管理员或系统触发某提交重测
- **THEN** noj-core 为该次重测生成新的 `eval_token` 并放入新的 JudgeTask
- **THEN** 旧 token 不参与新评测，按原 TTL 自然过期
