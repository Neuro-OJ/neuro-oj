## MODIFIED Requirements

### Requirement: evaluator SDK register_capability API

系统 SHALL 在 `noj_evaluator_sdk` 提供 `register_capability(name, handler, timeout_ms=None)`，供 evaluate.py 注册可被 solution 调用的能力，并可配置该 capability 调用的默认超时。

#### Scenario: 注册并处理调用

- **WHEN** evaluate.py 调用 `register_capability("request_llm_completion", handler)`
- **THEN** solution 的 `call_capability("request_llm_completion", ...)` 被转发到该 handler 执行
- **THEN** handler 返回值经 codec 编码后作为 result 帧返回

#### Scenario: 注册时配置默认超时

- **WHEN** evaluate.py 调用 `register_capability("request_llm_completion", handler, timeout_ms=10000)`
- **THEN** SDK 向 stdout 写一次性 `{"type":"cap_reg","name":"request_llm_completion","timeout_ms":10000}` 帧上报 judge
- **THEN** 该 capability 的后续调用按 10000ms 超时计时（缺省回退题目级 `call_timeout_ms`）

#### Scenario: 重复注册同名 capability

- **WHEN** evaluate.py 对同一名称注册两次
- **THEN** 第二次注册覆盖第一次（最近注册生效，含超时映射）

#### Scenario: 非法 timeout_ms 被拒绝

- **WHEN** `register_capability` 的 `timeout_ms` 为 0 / 负数 / 非整数
- **THEN** SDK 抛出 `ValueError`，不注册也不发出 cap_reg 帧

#### Scenario: handler 抛异常

- **WHEN** handler 执行时抛出异常
- **THEN** evaluator 返回 error 帧（code=Exception，含截断 traceback）
- **THEN** solution 侧抛出对应异常，评测流程不中断（evaluator 可捕获后继续）
