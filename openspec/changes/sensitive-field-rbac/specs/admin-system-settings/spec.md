## ADDED Requirements

### Requirement: judge 分类资源上限设置项

系统 SHALL 在 `lib/settings-registry.ts` 的注册表中新增 `judge` 分类（SettingCategory 联合类型扩展），包含 4 个 integer 类型设置项，default 均为 `0`（0 = 不限制），min 均为 `0`：

| key | default | description | envFallback |
|-----|---------|-------------|-------------|
| `judge_max_evaluator_time_limit_ms` | `0` | evaluator 单用例时限上限（毫秒），0=不限制 | `JUDGE_MAX_EVALUATOR_TIME_LIMIT_MS` |
| `judge_max_evaluator_memory_limit_mb` | `0` | evaluator 内存上限（MB），0=不限制 | `JUDGE_MAX_EVALUATOR_MEMORY_LIMIT_MB` |
| `judge_max_solution_call_timeout_ms` | `0` | solution 调用超时上限（毫秒），0=不限制 | `JUDGE_MAX_SOLUTION_CALL_TIMEOUT_MS` |
| `judge_max_solution_memory_limit_mb` | `0` | solution 内存上限（MB），0=不限制 | `JUDGE_MAX_SOLUTION_MEMORY_LIMIT_MB` |

设置项 SHALL 遵循既有 DB-backed 设置机制（`is_secret=false`、`needsRestart=false`、启动期注册表校验、管理后台按 category 分组动态渲染），由 `GET /api/v1/admin/settings` 自动返回、`PUT /api/v1/admin/settings/:key` 自动更新，无需前端改动。

#### Scenario: 设置项出现在设置列表中

- **WHEN** 管理员请求 `GET /api/v1/admin/settings`
- **THEN** 响应包含 4 个 `judge_max_*` 设置项，`category` 为 `judge`，默认值为 `0`

#### Scenario: 管理员更新上限

- **WHEN** 管理员 `PUT /api/v1/admin/settings/judge_max_evaluator_memory_limit_mb` 设置值为 `512`
- **THEN** 更新成功，后续写入校验读取该值作为 evaluator 内存上限

#### Scenario: 非法值被拒

- **WHEN** 管理员尝试将上限设置为非整数或负数
- **THEN** 系统按既有 integer 类型校验拒绝（min=0）
