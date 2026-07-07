## Purpose

系统设置项支持 integer（整数）类型，提供 min/max 范围校验用于数值类配置项（如速率限制参数）。

## Requirements

### Requirement: integer 类型支持

系统 SHALL 在 `SettingType` 联合类型中新增 `"integer"` 类型，`SettingDefinition` 接口新增可选的 `min` 和 `max` 字段用于范围校验。

`integer` 类型的校验规则 SHALL 包括：
- 值必须为 `number` 类型且 `Number.isInteger(value)` 为 true
- 若 `min` 已定义，值 SHALL ≥ min
- 若 `max` 已定义，值 SHALL ≤ max
- 浮点数和非数字类型 SHALL 被拒绝，返回 400 VALIDATION_ERROR

`integer` 类型 SHALL 在 `VALID_TYPES` 数组中注册，`validateRegistry()` 自动识别。

#### Scenario: 合法 integer 更新

- **WHEN** admin 调用 `PUT /api/v1/admin/settings/rate_limit_login_ip_max` body=`{value: 20}`
- **THEN** DB 行 UPSERT 成功，响应 200，`effective_value` 为数字 20

#### Scenario: 浮点数被拒绝

- **WHEN** admin 调用 `PUT /api/v1/admin/settings/rate_limit_login_ip_max` body=`{value: 10.5}`
- **THEN** 响应 400，message: 'rate_limit_login_ip_max 必须是整数（integer）'

#### Scenario: 超出 min 范围被拒绝

- **WHEN** admin 调用 `PUT /api/v1/admin/settings/rate_limit_login_backoff_sec` body=`{value: 0}`
- **AND** 该设置项定义了 `min: 1`
- **THEN** 响应 400，message: 'rate_limit_login_backoff_sec 不能小于 1（当前 0）'

#### Scenario: 超出 max 范围被拒绝

- **WHEN** admin 调用 `PUT /api/v1/admin/settings/rate_limit_login_lock_seconds` body=`{value: 99999}`
- **AND** 该设置项定义了 `max: 86400`
- **THEN** 响应 400，message: 'rate_limit_login_lock_seconds 不能大于 86400（当前 99999）'

#### Scenario: 非数字类型被拒绝

- **WHEN** admin 调用 `PUT /api/v1/admin/settings/rate_limit_login_ip_max` body=`{value: "twenty"}`
- **THEN** 响应 400，message: 'rate_limit_login_ip_max 必须是整数（integer）'

#### Scenario: 前端 integer 控件展示

- **WHEN** admin 访问 `/admin/settings` 页面
- **AND** 存在 type 为 `integer` 的 DB-backed 设置项
- **THEN** 该行渲染为 `<input type="number" :min="def.min" :max="def.max" step="1">` 控件
