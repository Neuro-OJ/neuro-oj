## Purpose

定义用户模型保留 capability 与现有 Evaluator capability 的边界。

## ADDED Requirements

### Requirement: 用户 BYOK 保留 capability

系统 SHALL 支持 `request_user_llm_completion`。Judge SHALL 直接调用 Gateway 并将结果返回 Solution，不得将该 capability 转发给 Evaluator。

#### Scenario: 已绑定配置

- **WHEN** Solution 调用 `request_user_llm_completion(prompt)` 且提交绑定有效配置
- **THEN** Judge 返回模型结果 capability result 帧
- **THEN** Evaluator 不会收到该请求帧

#### Scenario: 未绑定或网关不可用

- **WHEN** 提交没有有效配置或 Gateway 不可用
- **THEN** Judge 返回 `BYOK_CONFIG_UNAVAILABLE` 或 `BYOK_GATEWAY_UNAVAILABLE`
- **THEN** 不向 Evaluator 或 Provider 发起不必要的请求

#### Scenario: 既有 capability 兼容

- **WHEN** Solution 调用 `request_llm_completion`
- **THEN** Judge 继续按既有协议转发给 Evaluator，不自动切换 BYOK
