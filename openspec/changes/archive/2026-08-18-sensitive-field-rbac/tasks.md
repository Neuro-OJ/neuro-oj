## 1. 权限种子（敏感字段权限项）

- [x] 1.1 在 `noj-core/src/types/index.ts` 的 `PERMISSION_DEFS` 新增 `problem:field_evaluator_command` 与 `problem:field_evaluator_network`（含中文 description）
- [x] 1.2 在 `noj-core/src/services/seed-rbac.ts` 实现一次性默认授权（`SENSITIVE_FIELD_DEFAULT_PERMISSIONS` + `system_settings` 内部标记，不加入 `USER_DEFAULT_PERMISSIONS`，收紧后重启不恢复）

## 2. 资源上限设置项

- [x] 2.1 在 `noj-core/src/lib/settings-registry.ts` 扩展 `SettingCategory` 联合类型新增 `judge` 分类
- [x] 2.2 注册 4 个 integer 设置项：`judge_max_evaluator_time_limit_ms` / `judge_max_evaluator_memory_limit_mb` / `judge_max_solution_call_timeout_ms` / `judge_max_solution_memory_limit_mb`（default 0、min 0、category judge）
- [x] 2.3 验证 `validateRegistry()`、`GET /api/v1/admin/settings` 自动覆盖新设置项（无需前端改动，运行冒烟验证）

## 3. 共享守卫实现

- [x] 3.1 新建 `noj-core/src/services/problem-field-guard.ts`：`SENSITIVE_FIELD_PERMISSIONS` 静态映射（evaluator.command / evaluator.network → 权限项）
- [x] 3.2 实现 `assertSensitiveFieldPermissions(c, runtimeConfig)`：仅检查请求中显式存在的敏感字段，`assertPermission` 抛 403；兼容 CLI 无 Context 的 admin 退化路径（与 `isAdminActor` 一致）
- [x] 3.3 实现 `enforceResourceLimits(runtimeConfig)`：`RESOURCE_LIMIT_SETTINGS` 映射 + 读取设置，值 >0 且超限时抛 AppError(400, "RESOURCE_LIMIT_EXCEEDED"，错误含上限与实际值)

## 4. 三条写入路径接入

- [x] 4.1 `createProblem`（problems-crud.ts）在 `validateRuntimeConfig` 之后、落库之前调用守卫
- [x] 4.2 `updateProblem`（problems-crud.ts）同样接入（PATCH 语义：请求体未触及字段则放行）
- [x] 4.3 `importProblemBundle`（problem-bundle.ts）创建与更新两条子路径接入守卫；验证 CLI `problems import`（root 用户）天然放行

## 5. 测试覆盖

- [x] 5.1 服务层测试（tests/services/）：三条写入路径 × {默认放行 / 角色移除权限后 403 / 资源超限 400 / CLI root 放行}
- [x] 5.2 路由层测试（tests/routes/）：`POST /problems`、`PUT /problems/:id`、`POST /problems/import-bundle` 的权限与超限场景
- [x] 5.3 seed 测试：`ensureRbacSeeds` 后权限项存在、user 角色默认拥有、`admin:full_access` 通配放行

## 6. 收尾验证

- [x] 6.1 `deno fmt` + `deno lint` + noj-core 全量测试通过（无 DB 迁移、无 lock 变更）
- [x] 6.2 复核三条写入路径行为一致性（对照 specs 场景逐条核对）
