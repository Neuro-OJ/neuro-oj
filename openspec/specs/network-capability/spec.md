# network-capability Specification

## Purpose

定义 solution → evaluator 的 capability 调用能力：protocol（capability 帧 + result/error 响应按 id 匹配）、
`noj_solution_sdk.call_capability` / `noj_evaluator_sdk.register_capability` API 与安全模型
（solution 容器恒无网、capability 由 evaluator 显式注册、调用边界即信任边界）。
## Requirements
### Requirement: capability 调用协议

系统 SHALL 支持 solution 经 judge 转发调用 evaluator 注册的 capability，协议基于既有 NDJSON 帧通道。

#### Scenario: solution 发起 capability 调用

- **WHEN** solution 代码调用 `call_capability("http_fetch", ...)`
- **THEN** solution 进程向 stdout 输出 `{"type":"capability","id":"<hex>","name":"<capability名>","args":[...]}` 帧
- **THEN** judge 将帧原样转发到 evaluator stdin

#### Scenario: evaluator 返回 capability 结果

- **WHEN** evaluator 执行 capability handler 成功
- **THEN** evaluator 向 stdout 输出 `{"type":"result","id":"<与请求相同的id>","value":<编码值>}` 帧
- **THEN** judge 将 result 帧转发回 solution stdin
- **THEN** solution 的 `call_capability` 返回解码后的值

#### Scenario: capability 执行失败返回 error 帧

- **WHEN** evaluator 的 capability handler 抛出异常或拒绝参数
- **THEN** evaluator 输出 `{"type":"error","id":"<与请求相同的id>","code":"Exception"|"Rejected","message":"..."}` 帧
- **THEN** judge 转发回 solution，`call_capability` 抛出对应异常

#### Scenario: 未注册的 capability

- **WHEN** solution 调用未注册的 capability 名称
- **THEN** evaluator 输出 `{"type":"error","id":...,"code":"NotFound","message":"capability 'x' not registered"}`
- **THEN** judge 转发回 solution，`call_capability` 抛出 `CapabilityNotFoundError`

#### Scenario: judge 转发 evaluator 的 result/error 帧

- **WHEN** evaluator stdout 出现 `type=result` 或 `type=error` 的协议帧
- **THEN** judge 将其转发到 solution stdin
- **WHEN** evaluator stdout 出现普通文本或 `---RESULT---` 标记
- **THEN** 不转发（保持既有行为）

### Requirement: solution SDK call_capability API

系统 SHALL 在 `noj_solution_sdk` 提供 `call_capability(name, *args)`，供用户代码在注册函数内调用。

#### Scenario: 基本调用

- **WHEN** 用户代码调用 `from noj_solution_sdk import call_capability; call_capability("request_llm_completion", prompt)`
- **THEN** 函数阻塞等待 evaluator 响应，返回解码后的结果

#### Scenario: 参数类型校验

- **WHEN** `args` 含不可序列化类型（自定义对象、函数等）
- **THEN** 抛出 `CapabilityRejectedError`（公共 API，可被用户捕获），不发帧

#### Scenario: solution 无网络能力

- **WHEN** 评测沙箱中 solution 容器被配置为 `network_mode: none`
- **THEN** solution 内任何直接网络请求（socket/urllib 等）失败
- **THEN** solution 仅能通过 `call_capability` 间接使用网络

### Requirement: evaluator 联网启用权限

系统 SHALL 允许具有题目创建权限的用户在题目 `runtime_config.evaluator.network` 中启用联网（`enabled=true`），不要求 admin 角色；联网权限与题目创建/编辑权限一致，不单独设限。

#### Scenario: 普通用户创建 U 型题目开启联网

- **WHEN** 任意登录用户创建 U 型题目且 `runtime_config.evaluator.network.enabled = true`
- **THEN** 题目创建成功，评测时 evaluator 容器以 bridge 模式联网（solution 容器仍为 `network_mode: none`）

#### Scenario: 管理员创建 P 型题目开启联网

- **WHEN** admin 创建 P 型题目且 `runtime_config.evaluator.network.enabled = true`
- **THEN** 题目创建成功

#### Scenario: 普通用户创建 P 型题目开启联网

- **WHEN** 非 admin 创建 P 型题目（即使带联网配置）
- **THEN** 创建被拒绝（沿用 P 型仅 admin 的创建权限，与联网配置无关）

#### Scenario: 编辑既有题目开启/关闭联网

- **WHEN** 用户编辑题目并在 `runtime_config` 中变更 `evaluator.network.enabled`
- **THEN** 仅当该用户对题目有编辑权限时生效（U 型 owner/admin、P 型 admin），否则拒绝

#### Scenario: 题目包导入开启联网

- **WHEN** 用户通过题目包导入创建题目且 `manifest.runtime_config.evaluator.network.enabled = true`
- **THEN** 与直接创建同权限语义：普通用户导入创建 U 型题可开启，P 型仅 admin

### Requirement: evaluator SDK register_capability API

系统 SHALL 在 `noj_evaluator_sdk` 提供 `register_capability(name, handler)`，供 evaluate.py 注册可被 solution 调用的能力。

#### Scenario: 注册并处理调用

- **WHEN** evaluate.py 调用 `register_capability("request_llm_completion", handler)`
- **THEN** solution 的 `call_capability("request_llm_completion", ...)` 被转发到该 handler 执行
- **THEN** handler 返回值经 codec 编码后作为 result 帧返回

#### Scenario: 重复注册同名 capability

- **WHEN** evaluate.py 对同一名称注册两次
- **THEN** 第二次注册覆盖第一次（最近注册生效）

#### Scenario: handler 抛异常

- **WHEN** handler 执行时抛出异常
- **THEN** evaluator 返回 error 帧（code=Exception，含截断 traceback）
- **THEN** solution 侧抛出对应异常，评测流程不中断（evaluator 可捕获后继续）