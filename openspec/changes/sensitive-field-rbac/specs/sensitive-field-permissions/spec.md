## ADDED Requirements

### Requirement: 题目敏感字段权限项

系统 SHALL 为 `runtime_config` 中的高危敏感字段定义独立 RBAC 权限项，权限命名遵循 `resource:action` 约定，`field_` 前缀标识字段级权限：

- `problem:field_evaluator_command`：设置/修改题目 `runtime_config.evaluator.command`
- `problem:field_evaluator_network`：设置/修改题目 `runtime_config.evaluator.network`（联网开关）

系统 SHALL 将上述权限项加入 `PERMISSION_DEFS`（`src/types/index.ts`），由 `ensureRbacSeeds()` 幂等插入 `permissions` 表，无需 DB 迁移。`admin:full_access` 通配放行语义 SHALL 适用于这些权限项（admin 不受收紧影响）。

#### Scenario: 种子补齐敏感字段权限项

- **WHEN** 系统在已有数据库上启动并执行 `ensureRbacSeeds()`
- **THEN** `permissions` 表存在 `problem:field_evaluator_command` 与 `problem:field_evaluator_network` 两条记录（ON CONFLICT DO NOTHING 幂等，不产生重复行）

#### Scenario: admin 隐式拥有敏感字段权限

- **WHEN** 持有 `admin:full_access` 权限的用户设置 `evaluator.network.enabled = true`
- **THEN** 权限检查通过（通配放行），无需在角色上显式分配 `problem:field_evaluator_network`

### Requirement: 敏感字段写入权限检查

系统 SHALL 在题目写入路径中对请求中**显式设置**的敏感字段执行权限检查：请求 `runtime_config` 中显式包含（值非 `null`/`undefined`，`null` 视为未设置，与 `problem-runtime-config` spec 的 `network` 缺省语义一致）`evaluator.command` 时 SHALL 检查 `problem:field_evaluator_command`；显式包含 `evaluator.network` 时 SHALL 检查 `problem:field_evaluator_network`。无对应权限时 SHALL 返回 HTTP 403（`FORBIDDEN`）且不落库。

检查 SHALL 在三条写入路径上行为一致：CRUD 创建（`POST /problems`）、CRUD 更新（`PUT /problems/:id`）、题目包导入（`POST /problems/import-bundle` 与 CLI `problems import`）。更新路径中请求体未触及敏感字段时 SHALL 放行（不比较新旧值）。CLI 导入（root 用户）SHALL 通过 `admin:full_access` 天然放行。

`evaluator.command` 为 `runtime_config` 必填字段（CRUD 必填、题目包导入缺省注入默认值），因此任何写入路径的 `runtime_config` 都包含 `evaluator.command`，检查对每次写入恒触发——收紧该权限即表示"仅授权者可配置题目评测命令（含整体 `runtime_config` 写入）"。

#### Scenario: 注入的 command 同样触发检查

- **WHEN** 无 `problem:field_evaluator_command` 权限的用户导入 manifest 未显式写 `evaluator.command`（系统注入默认值）的题目包
- **THEN** 系统返回 HTTP 403（command 为必注入字段，导入即设置 command），不创建、不更新题目

#### Scenario: 收紧后创建题目标识敏感字段被拒

- **WHEN** 角色权限中不含 `problem:field_evaluator_command` 的用户调用 `POST /problems` 且请求 `runtime_config.evaluator.command` 显式存在
- **THEN** 系统返回 HTTP 403，题目不创建

#### Scenario: 收紧后更新题目不触及敏感字段放行

- **WHEN** 无 `problem:field_evaluator_command` 权限的用户调用 `PUT /problems/:id` 更新标题，请求体不含 `evaluator.command`
- **THEN** 更新成功（字段权限不检查，既有 command 值保持不变）

#### Scenario: 收紧后更新题目标识敏感字段被拒

- **WHEN** 无 `problem:field_evaluator_network` 权限的用户调用 `PUT /problems/:id` 且请求 `runtime_config.evaluator.network` 显式存在（即使值与现值相同）
- **THEN** 系统返回 HTTP 403，`runtime_config` 不更新

#### Scenario: 默认授权下设置敏感字段放行

- **WHEN** 拥有 `problem:field_evaluator_command` 与 `problem:field_evaluator_network` 权限的用户（默认 user 角色）设置任意敏感字段
- **THEN** 权限检查通过，按既有校验流程继续（结构校验、镜像白名单等）

#### Scenario: 导入包敏感字段权限一致

- **WHEN** 无 `problem:field_evaluator_network` 权限的用户导入 manifest 含 `evaluator.network.enabled = true` 的题目包
- **THEN** 系统返回 HTTP 403，不创建、不更新题目
- **WHEN** 管理员（或 CLI root 用户）导入相同包
- **THEN** 导入成功（`admin:full_access` 放行）

### Requirement: 敏感字段权限默认放行

系统 SHALL 对 `problem:field_evaluator_command` 与 `problem:field_evaluator_network` 执行**一次性**默认授权（`ensureSensitiveFieldDefaultPermissions`）：首次 seed 时授予 default user 角色（默认放行），使新注册用户与存量用户默认拥有，保证现有行为与存量题目不受影响；已 seed 清单记录于 `system_settings` 内部标记（`rbac_sensitive_field_permissions_seeded`，不注册、不展示、不可经 API 修改），**后续重启不会恢复被移除的授权**。管理员收紧 SHALL 通过角色管理（`admin/roles.vue` 权限勾选）从角色移除对应授权实现。

#### Scenario: 新注册用户默认拥有敏感字段权限

- **WHEN** 新用户注册并获得 default user 角色
- **THEN** 该用户权限集包含 `problem:field_evaluator_command` 与 `problem:field_evaluator_network`

#### Scenario: 存量用户默认拥有敏感字段权限

- **WHEN** 部署本变更后启动 `ensureRbacSeeds()`，存量用户已关联 user 角色（`migrateExistingUsers` 保证）
- **THEN** 存量用户权限集包含两个敏感字段权限项，可继续设置敏感字段（存量行为不变）

#### Scenario: 管理员收紧后拒绝

- **WHEN** 管理员在角色管理中从 user 角色移除 `problem:field_evaluator_network` 授权
- **THEN** 仅持有 user 角色的用户设置 `evaluator.network` 时收到 HTTP 403
