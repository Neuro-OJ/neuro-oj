## MODIFIED Requirements

### Requirement: evaluator 网络配置

系统 SHALL 支持按题目配置 evaluator 容器联网开关 `runtime_config.evaluator.network`，缺省关闭（与现状一致）。设置该字段 SHALL 受 `problem:field_evaluator_network` 权限约束（见 `sensitive-field-permissions` spec）：请求中显式设置 `evaluator.network` 时，写入方 SHALL 拥有对应权限，否则返回 HTTP 403。

#### Scenario: network 字段缺省

- **WHEN** `runtime_config.evaluator.network` 缺省或为 `null`
- **THEN** 系统视为 `{"enabled": false}`（evaluator 无网，向后兼容）
- **THEN** 不触发字段权限检查（未显式设置）

#### Scenario: network.enabled 为布尔

- **WHEN** 用户设置 `runtime_config.evaluator.network`
- **THEN** 系统校验 `enabled` 必须为布尔值
- **WHEN** `enabled` 非布尔（字符串/数字等）
- **THEN** 返回 HTTP 400 + 明确错误信息（如 `runtime_config.evaluator.network 必须是对象` / `runtime_config.evaluator.network.enabled 必须是布尔值`）

#### Scenario: network.enabled=true 生效

- **WHEN** `runtime_config.evaluator.network.enabled = true` 且提交评测
- **THEN** judge 以 bridge 网络模式创建 evaluator 容器
- **THEN** solution 容器仍为 `network_mode: none`

#### Scenario: 无权限设置 network 被拒

- **WHEN** 写入方权限集不含 `problem:field_evaluator_network` 且请求显式设置 `runtime_config.evaluator.network`
- **THEN** 系统返回 HTTP 403，不落库（三条写入路径一致）

### Requirement: 敏感字段与资源上限写入约束

系统 SHALL 在题目写入路径（CRUD 创建、CRUD 更新、题目包导入）中，对 `runtime_config` 的敏感字段与资源限制字段执行服务端强制检查，检查时机为结构校验（`validateRuntimeConfig`）之后、落库之前：

- `evaluator.command`：显式设置时检查 `problem:field_evaluator_command` 权限
- `evaluator.network`：显式设置时检查 `problem:field_evaluator_network` 权限
- `evaluator.time_limit_ms` / `evaluator.memory_limit_mb` / `solution.call_timeout_ms` / `solution.memory_limit_mb`：显式设置时校验对应 `judge_max_*` 全局上限（见 `problem-resource-limits` spec）

无权限 SHALL 返回 HTTP 403；超限 SHALL 返回 HTTP 400（`RESOURCE_LIMIT_EXCEEDED`）。三条路径 SHALL 共用同一守卫实现，行为一致。

#### Scenario: 三条写入路径共享守卫

- **WHEN** 分别通过 CRUD 创建、CRUD 更新、题目包导入写入含敏感字段/超限字段的 `runtime_config`
- **THEN** 三条路径执行相同顺序的权限与上限校验，返回一致的错误码

#### Scenario: 校验失败不落库

- **WHEN** 权限检查或上限校验失败
- **THEN** 系统不创建、不更新题目，`runtime_config` 不被修改
