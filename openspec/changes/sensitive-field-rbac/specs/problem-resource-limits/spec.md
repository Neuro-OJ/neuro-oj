## ADDED Requirements

### Requirement: 资源限制全局上限设置项

系统 SHALL 在 `lib/settings-registry.ts` 中新增 `judge` 分类的 4 个 integer 设置项，用于管理员配置题目资源限制字段的全局上限（默认 `0` = 不限制，`>0` 时启用）：

| key | type | default | description | min |
|-----|------|---------|-------------|-----|
| `judge_max_evaluator_time_limit_ms` | integer | `0` | evaluator 单用例时限上限（毫秒），0=不限制 | 0 |
| `judge_max_evaluator_memory_limit_mb` | integer | `0` | evaluator 内存上限（MB），0=不限制 | 0 |
| `judge_max_solution_call_timeout_ms` | integer | `0` | solution 调用超时上限（毫秒），0=不限制 | 0 |
| `judge_max_solution_memory_limit_mb` | integer | `0` | solution 内存上限（MB），0=不限制 | 0 |

设置项 SHALL 由管理后台设置页（`admin/settings.vue`，按 category 动态渲染）自动展示与编辑，无需前端代码改动。

#### Scenario: 设置项默认不限制

- **WHEN** 全新部署且管理员未配置上限
- **THEN** 四个设置项值为 `0`，任何资源限制值均可写入（与现状一致）

#### Scenario: 设置项出现在管理后台

- **WHEN** 管理员打开系统设置页
- **THEN** 页面展示 judge 分类下的四个上限设置项，可按 integer 类型编辑保存

#### Scenario: 负数配置被拒

- **WHEN** 管理员尝试将上限设置为负数
- **THEN** 系统拒绝（integer 类型 min=0 校验）

### Requirement: 资源超限拒绝写入

系统 SHALL 在题目写入路径中对请求中**显式设置**的资源限制字段执行上限校验：`evaluator.time_limit_ms` 对 `judge_max_evaluator_time_limit_ms`、`evaluator.memory_limit_mb` 对 `judge_max_evaluator_memory_limit_mb`、`solution.call_timeout_ms` 对 `judge_max_solution_call_timeout_ms`、`solution.memory_limit_mb` 对 `judge_max_solution_memory_limit_mb`。对应上限配置 `>0` 且请求值超过上限时 SHALL 返回 HTTP 400（`RESOURCE_LIMIT_EXCEEDED`，错误信息含上限值与实际值）且不落库。

校验 SHALL 在三条写入路径（CRUD 创建、CRUD 更新、题目包导入）行为一致；更新路径未触及对应字段时 SHALL 放行。存量题目不受影响（仅写入时校验，不迁移既有数据）。

#### Scenario: 创建题目超限被拒

- **WHEN** 管理员配置 `judge_max_evaluator_memory_limit_mb = 512`，用户创建题目设置 `evaluator.memory_limit_mb = 1024`
- **THEN** 系统返回 HTTP 400 与 `RESOURCE_LIMIT_EXCEEDED`，题目不创建

#### Scenario: 更新题目超限被拒

- **WHEN** 管理员配置 `judge_max_solution_call_timeout_ms = 5000`，用户更新题目设置 `solution.call_timeout_ms = 10000`
- **THEN** 系统返回 HTTP 400，`runtime_config` 不更新

#### Scenario: 未超限或未配置上限放行

- **WHEN** 上限未配置（0）或请求值未超过上限
- **THEN** 资源校验通过，继续既有校验流程

#### Scenario: 导入包超限被拒

- **WHEN** 管理员配置 `judge_max_evaluator_time_limit_ms = 5000`，导入 manifest 含 `evaluator.time_limit_ms = 10000` 的题目包
- **THEN** 系统返回 HTTP 400 与 `RESOURCE_LIMIT_EXCEEDED`，不创建、不更新题目
