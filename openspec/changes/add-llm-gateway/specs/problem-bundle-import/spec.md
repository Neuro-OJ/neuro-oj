## ADDED Requirements

### Requirement: manifest.llm 字段

系统 SHALL 支持 `problem.json` 顶层可选字段 `llm`，用于声明题目可用的 LLM Provider 与模型。`llm` MUST 为对象，包含 `provider_id`（非空字符串）与 `model`（非空字符串）；该字段仅对受信题目（管理员 P 型/官方题或审核通过题目）合法，且必须与 `runtime_config.evaluator.network.enabled = true` 同时出现。

#### Scenario: 合法 llm 字段

- **WHEN** 导入包中的 `problem.json` 包含 `llm: {"provider_id": "uuid", "model": "qwen-plus"}`，且 `runtime_config.evaluator.network.enabled = true`
- **THEN** 导入校验通过，`llm` 配置写入题目 `llm_config`

#### Scenario: llm 字段缺少 model

- **WHEN** `problem.json` 的 `llm` 缺少 `model` 或 `model` 为空
- **THEN** 系统返回 HTTP 400，提示 `llm.model` 必填

#### Scenario: llm 字段未开启网络

- **WHEN** `problem.json` 包含 `llm` 但 `runtime_config.evaluator.network.enabled` 不是 true
- **THEN** 系统返回 HTTP 400，提示必须启用 evaluator 网络

#### Scenario: 非受信题目携带 llm

- **WHEN** 导入 U 型题目或未审核题目且 `problem.json` 包含 `llm`
- **THEN** 系统返回 HTTP 403，提示仅受信题目可启用 LLM
