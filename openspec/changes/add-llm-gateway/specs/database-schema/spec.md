## ADDED Requirements

### Requirement: problems.llm_config 列

系统 SHALL 在 `problems` 表新增可空 JSONB 列 `llm_config`，用于存储题目固定的 LLM 配置（`provider_id`、`model`）。非 LLM 题目该列为 NULL。

#### Scenario: 创建 LLM 题目

- **WHEN** 创建携带 `llm` 配置的题目
- **THEN** `problems.llm_config` 存储 `{"provider_id": "...", "model": "..."}`

#### Scenario: 非 LLM 题目

- **WHEN** 创建不携带 `llm` 配置的题目
- **THEN** `problems.llm_config` 为 NULL

### Requirement: LLM 网关相关表

系统 SHALL 提供 `llm_providers`、`llm_usage`、`llm_quotas` 表，用于存储 Provider 配置、调用审计与配额配置。

#### Scenario: llm_providers 表

- **WHEN** 检查 `llm_providers` 表结构
- **THEN** 表包含 `id`、`name`、`base_url`、`model`、`encrypted_api_key`、`enabled`、`created_by`、`created_at`、`updated_at`

#### Scenario: llm_usage 表

- **WHEN** 检查 `llm_usage` 表结构
- **THEN** 表包含 `id`、`submission_id`、`problem_id`、`user_id`、`provider_id`、`model`、`request_messages`（JSONB）、`request_params`（JSONB）、`prompt_tokens`、`completion_tokens`、`total_tokens`、`estimated_cost`、`latency_ms`、`status`、`error_code`、`prompt_hash`、`created_at`

#### Scenario: llm_quotas 表

- **WHEN** 检查 `llm_quotas` 表结构
- **THEN** 表包含 `id`、`scope_type`（`user`/`problem`/`global`）、`scope_id`、`window_type`（`day`/`month`）、`max_calls`、`max_tokens`、`max_cost`、`created_at`、`updated_at`
