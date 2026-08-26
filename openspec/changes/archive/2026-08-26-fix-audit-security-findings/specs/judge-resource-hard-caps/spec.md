## ADDED Requirements

### Requirement: judge 侧资源硬上限

judge SHALL 在创建容器前对任务中的资源限制字段执行硬上限收敛，即使 core 配置缺失或消息被篡改，单次评测也不得超过以下绝对上限：

- Evaluator `time_limit_ms`：不超过 `MAX_EVALUATOR_TIME_MS`（默认 300000）
- Evaluator `memory_limit_mb`：不超过 4096
- Solution `call_timeout_ms`：不超过 `MAX_SOLUTION_CALL_TIMEOUT_MS`（默认 60000）
- Solution `memory_limit_mb`：不超过 4096

超限值 SHALL 被 clamp 到上限，或直接拒绝任务；MUST NOT 按原值创建容器。

#### Scenario: 超长时限被收敛

- **WHEN** 任务携带 `evaluator.time_limit_ms = 3600000`
- **THEN** judge 按硬上限 300000 执行，或拒绝该任务

#### Scenario: 超大内存被收敛

- **WHEN** 任务携带 `evaluator.memory_limit_mb = 8192`
- **THEN** judge 按 4096 创建容器，或拒绝该任务

### Requirement: 结果状态白名单

judge 解析 evaluator 返回的 `---RESULT---` 时，`status` 字段 MUST 映射到已知状态集合；未知状态 MUST 归为 `SystemError`，不得原样写入结果。

#### Scenario: 未知状态归为 SystemError

- **WHEN** evaluator 返回 `{"status":"Hacked","score":100}`
- **THEN** judge 将结果状态写为 `SystemError`

### Requirement: 分数范围校验

judge 解析 evaluator 返回的 `score` 时，MUST 将值限制在 `0..=10000`（×100 分制）范围内；超出范围的值 MUST 被 clamp 或归零。

#### Scenario: 超大分数被限制

- **WHEN** evaluator 返回 `{"status":"Accepted","score":999999}`
- **THEN** judge 将 score 限制为 10000（或拒绝该结果）
