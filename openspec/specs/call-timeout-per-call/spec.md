# call-timeout-per-call Specification

## Purpose

定义调用级超时能力：Evaluator SDK 每次 `runner.call()` 可指定独立超时（缺省回退题目级 `call_timeout_ms`），capability 调用采用注册时配置的默认超时；Judge Worker 以 in-flight 追踪实现参数化超时执行。

## Requirements

### Requirement: 调用级超时参数（Evaluator SDK）

系统 SHALL 在 `noj_evaluator_sdk` 的 `SolutionRunner.call()` 提供可选 `timeout_ms` 参数，使每次调用可指定独立超时。

#### Scenario: 按调用指定超时

- **WHEN** evaluate.py 调用 `runner.call("solve", 1, 2, timeout_ms=5000)`
- **THEN** 本次调用的超时按 5000ms 执行（覆盖题目级默认值）

#### Scenario: 缺省回退题目级默认

- **WHEN** evaluate.py 调用 `runner.call("solve", 1, 2)`（不带 `timeout_ms`）
- **THEN** 本次调用的超时回退到题目级 `runtime_config.solution.call_timeout_ms`

#### Scenario: 非法 timeout_ms 被拒绝

- **WHEN** `timeout_ms` 为 0 / 负数 / 非整数
- **THEN** SDK 立即抛出 `ValueError`，不发出 call 帧

### Requirement: call 帧 timeout_ms 字段

系统 SHALL 在 call 帧中支持可选 `timeout_ms` 字段，仅由 Judge Worker 用于计时。

#### Scenario: 帧携带 timeout_ms

- **WHEN** `runner.call(..., timeout_ms=5000)` 发出 call 帧
- **THEN** 帧包含 `"timeout_ms": 5000` 字段
- **THEN** judge 以该值作为本次调用的超时
- **THEN** Solution Host 执行逻辑不感知该字段（原样透传，host 忽略多余字段）

#### Scenario: 帧缺省不带字段

- **WHEN** `runner.call(...)` 未指定 `timeout_ms`
- **THEN** call 帧不含 `timeout_ms` 字段（向后兼容旧 SDK / 旧题目）

### Requirement: Judge 调用级超时执行

系统 SHALL 在 Judge Worker 双容器主循环中实现调用级超时：in-flight 追踪 + 参数化超时，超时向等待方返回 `Timeout` 错误帧。

#### Scenario: 超时计时起点

- **WHEN** judge 收到 evaluator 的 call 帧（或 solution 的 capability 帧）
- **THEN** 超时自该时刻起算，到期未收到响应则判定该调用超时

#### Scenario: 超时返回 Timeout 错误帧

- **WHEN** 单次调用在生效超时内未收到响应
- **THEN** judge 向等待方写 `{"type":"error","id":"<调用id>","code":"CallTimeout","message":"..."}` 错误帧
- **THEN** Evaluator 侧 `runner.call()` 抛出 `SolutionTimeoutError`（capability 方向则 solution 侧收到对应错误）
- **THEN** Solution Host 进程继续运行（不退出），后续调用可正常执行

#### Scenario: 迟到响应丢弃

- **WHEN** 某调用已超时后其响应帧才到达
- **THEN** judge 按 id 匹配丢弃该迟到响应，不转发给等待方

#### Scenario: 并发调用各自独立计时

- **WHEN** 同一次评测内多个调用并发进行且超时值不同
- **THEN** 每个调用按各自生效超时独立计时，互不影响

### Requirement: capability 注册默认超时（cap_reg）

系统 SHALL 支持 `register_capability(name, handler, timeout_ms=None)` 配置 capability 调用的默认超时，并经 `cap_reg` 帧一次性上报 Judge。

#### Scenario: 注册时配置默认超时

- **WHEN** evaluate.py 调用 `register_capability("request_llm_completion", handler, timeout_ms=10000)`
- **THEN** SDK 向 stdout 写一次性 `{"type":"cap_reg","name":"request_llm_completion","timeout_ms":10000}` 帧
- **THEN** judge 记录该 capability 的默认超时映射，后续 capability 调用按此值计时

#### Scenario: 注册缺省超时

- **WHEN** `register_capability(name, handler)` 未指定 `timeout_ms`
- **THEN** cap_reg 帧不含 `timeout_ms` 字段
- **THEN** judge 删除该 capability 的映射，其调用回退题目级 `call_timeout_ms`

#### Scenario: cap_reg 帧不转发

- **WHEN** judge 收到 evaluator 的 cap_reg 帧
- **THEN** judge 仅更新映射，不将该帧转发给 Solution Host
