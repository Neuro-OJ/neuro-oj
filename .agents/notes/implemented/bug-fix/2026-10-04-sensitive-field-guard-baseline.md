# Agent Note: 题目敏感字段守卫改为"相对基线变化才检查"

Status: implemented

## Problem

普通用户在网页编辑器保存编程题时报错"权限不足：设置敏感字段 evaluator.command
需要权限 problem:field_evaluator_command"。

`assertSensitiveFieldPermissions`（issue #207）的语义是"字段显式设置（非 null）即检查"，
而 `evaluator.command` 是 `validateRuntimeConfig` 强制的必填非空字段，前端每次保存都回传完整
`runtime_config`，题目包导入也会先注入默认命令再检查。NOJ-062 从 `user` 角色撤销敏感字段
权限后，非管理员在三条写入路径（CRUD 创建 / CRUD 更新 / 题目包导入）上全部 403——无法创建、
也无法编辑任何编程题（即使未改动评测命令）。既有测试把"默认命令被拒"当作预期行为固化，
部分路由用例的 403 实际来自缺少 `problem:create`，并未覆盖守卫本身。

## Decision

- 守卫比较敏感字段的**生效值**与**基线**，不同才检查权限：
  - 基线：更新 / 按 number 覆盖导入时为库中既有 `runtime_config`；创建时为平台默认值；
  - 归一化：command 空白 → `DEFAULT_EVALUATOR_COMMAND`；network 仅 `enabled === true` 视为联网
    （与 judge 端 `network.map(|n| n.enabled).unwrap_or(false)` 一致）。
- `updateProblem` 与 bundle `updateExisting` 传入既有 `runtime_config` 作为基线。
- 测试改为覆盖：默认值放行、原样回传放行、自定义 command / 开启联网 / 修改既有值拒绝；
  路由用例改用持有 `problem:create` 的默认用户，并断言错误信息指向具体敏感字段。

## Alternatives considered

- 把敏感字段权限还给 `user` 角色：等于撤回 NOJ-062 的安全收紧，否决。
- 让前端只在改动时发送 command：服务端仍须防御直接调用 API 的客户端，且 command 为必填，
  无法省略；否决。

## Consequences

- 非管理员可以正常创建/编辑使用默认评测命令、不联网的编程题；自定义命令或联网仍需管理员授权。
- 管理员为某题设置了自定义命令后，题目 owner 可继续编辑其他字段（原样回传不触发检查），
  但不能再修改该命令。
- 未来新增敏感字段需在 `effectiveSensitiveValue` 中定义其默认生效值，否则按"非 null 即偏离默认"处理。
