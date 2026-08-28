## ADDED Requirements

### Requirement: JudgeTask.llm 字段

系统 SHALL 支持 `JudgeTask` 新增可选 `llm` 对象，字段为 `gateway_url`、`eval_token`、`provider_id`、`allowed_models`。仅启用 LLM 的评测任务携带该字段。

#### Scenario: LLM 任务携带 llm

- **WHEN** noj-core 为启用 LLM 的题目构造 JudgeTask
- **THEN** JudgeTask 包含 `llm.gateway_url`、`llm.eval_token`、`llm.provider_id`、`llm.allowed_models`

#### Scenario: 非 LLM 任务无 llm

- **WHEN** noj-core 为普通题目构造 JudgeTask
- **THEN** JudgeTask 不包含 `llm` 字段或为 null

### Requirement: evaluator 环境变量注入

系统 SHALL 在启动 Evaluator exec 时，将 JudgeTask.llm 中的值注入环境变量：`NOJ_LLM_GATEWAY_URL`、`NOJ_LLM_TOKEN`、`NOJ_LLM_PROVIDER_ID`、`NOJ_LLM_ALLOWED_MODELS`。Solution 容器 MUST NOT 获得这些环境变量。

#### Scenario: 注入 evaluator

- **WHEN** JudgeTask 含 `llm` 且 noj-judge 创建 Evaluator exec
- **THEN** Evaluator 进程环境包含上述四个 `NOJ_LLM_*` 变量

#### Scenario: 不注入 solution

- **WHEN** noj-judge 创建 Solution exec
- **THEN** Solution 进程环境不包含任何 `NOJ_LLM_*` 变量

#### Scenario: 非 LLM 任务不注入

- **WHEN** JudgeTask 不含 `llm`
- **THEN** Evaluator 进程环境不包含 `NOJ_LLM_*` 变量
