## ADDED Requirements

### Requirement: 题目 CRUD 的 LLM 配置校验

系统 SHALL 在题目创建、更新接口中支持可选 `llm` 字段，并在服务端强制校验：仅管理员创建的 P 型/官方题或审核通过题目可携带 `llm`；携带 `llm` 时必须同时满足 `runtime_config.evaluator.network.enabled = true`。任一条件不满足时，创建/更新 MUST 返回 4xx 错误。

#### Scenario: 管理员创建 P 型 LLM 题

- **WHEN** 管理员调用创建题目 API，携带 `type='P'`、合法 `llm` 配置、`runtime_config.evaluator.network.enabled = true`
- **THEN** 系统创建成功，`llm_config` 写入题目

#### Scenario: 普通用户创建 U 型 LLM 题被拒

- **WHEN** 普通用户调用创建题目 API，携带 `type='U'` 和 `llm` 配置
- **THEN** 系统返回 403

#### Scenario: 缺少网络开关被拒

- **WHEN** 用户调用创建/更新题目 API，携带 `llm` 配置但 `runtime_config.evaluator.network.enabled` 不为 true
- **THEN** 系统返回 400

#### Scenario: 更新时移除网络开关被拒

- **WHEN** 更新已启用 LLM 的题目，payload 将 `runtime_config.evaluator.network.enabled` 置为 false
- **THEN** 系统返回 400

#### Scenario: 清空 llm 配置

- **WHEN** 更新题目时将 `llm` 置为 null 或省略
- **THEN** 系统允许移除 LLM 配置，题目回退为普通评测题目
