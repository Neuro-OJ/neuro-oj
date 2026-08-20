## Context

issue #207：题目 `runtime_config` 的敏感字段（联网开关、评测命令、资源限制）权限与题目创建/编辑权限整体绑定，无法按需收紧或下放。现状（已探明）：

- RBAC 体系：`permissions` / `role_permissions` / `user_roles` 表 + `assertPermission(c, "resource:action")`（`src/lib/permissions.ts`），权限种子静态定义于 `PERMISSION_DEFS`（`src/types/index.ts`），default user 角色默认授权列表 `USER_DEFAULT_PERMISSIONS`（`src/services/seed-rbac.ts:25-44`），`migrateExistingUsers()` 为存量用户补齐 user 角色（:181-208）
- 三条写入路径：`createProblem`（`src/services/problems-crud.ts:51-181`）、`updateProblem`（:196-308）、`importProblemBundle`（`src/services/problem-bundle.ts:119-228`，CLI 以 root 用户 + `userRole: "admin"` 退化调用，无 Context）
- `runtime_config` 结构：`evaluator.{image, command, time_limit_ms, memory_limit_mb, network.enabled}` + `solution.{image, entry, call_timeout_ms, memory_limit_mb}`（`src/types/index.ts:4-39`）
- 管理后台 UI 动态渲染设置项与权限项（`admin/settings.vue`、`admin/roles.vue`），新增项自动出现

约束：验收标准要求默认全放行、存量题目零影响、三条写入路径行为一致、服务端强制。

## Goals / Non-Goals

**Goals:**
- `evaluator.command`、`evaluator.network` 成为独立 RBAC 权限项，默认放行、可收紧，收紧后无权限者设置/修改返回 403
- 资源限制字段（`evaluator.time_limit_ms` / `evaluator.memory_limit_mb` / `solution.call_timeout_ms` / `solution.memory_limit_mb`）由管理员后台全局上限约束，超限拒绝
- 创建 / 更新 / 导入三条写入路径行为一致（含 CLI 导入，root 用户天然放行）
- 服务层 + 路由层测试覆盖

**Non-Goals:**
- 不覆盖 `solution.image` / `evaluator.image`（已有 `judge_images` 白名单）与 `solution.entry`（已有路径穿越校验）
- 不覆盖读取路径（公开 GET 仍原样返回 `runtime_config`，issue 验收仅写入）
- 不做字段掩码 / 部分更新合并等
- 不新增 DB 表与迁移；不引入运行时动态权限注册机制

## Decisions

### D1: 默认放行机制 = default 角色默认授权（用户选定）

新权限项加入 `PERMISSION_DEFS`（种子幂等插入）**并**通过 `ensureSensitiveFieldDefaultPermissions()` 执行**一次性**默认授权（`SENSITIVE_FIELD_DEFAULT_PERMISSIONS` + `system_settings` 内部标记，**不加入** `USER_DEFAULT_PERMISSIONS`——避免每次启动的幂等补齐撤销管理员收紧）——所有注册用户与存量用户（`migrateExistingUsers` 保证）默认拥有 → 默认放行；管理员收紧 = 从角色移除授权（`admin/roles.vue` 已支持勾选管理），重启不恢复。

- **备选 A（default_grant 列）**：`permissions` 表加列，`checkPermission` 对标记项无显式授权时返回 true。改动权限核心语义，收紧语义（移除 vs 撤销）易混淆，风险大 → 否决
- **备选 B（系统设置收紧列表）**：settings 存"被收紧字段清单"，检查时先查清单。需维护两份状态（清单 + 角色授权），且权限项在角色 UI 中不可见、不可分配 → 否决
- **本方案**：零 schema 变更、完全复用 RBAC 语义、权限项天然出现在角色管理 UI 中，收紧/下放均通过既有授权操作完成

### D2: 检查语义 = 请求中显式设置该字段才触发检查

- 创建：请求 `runtime_config` 中显式含 `evaluator.command` / `evaluator.network` → 分别检查对应权限
- 更新：请求体（PATCH 语义）中显式含该字段 → 检查；不触及字段则放行（不比较新旧值）
- 导入：manifest 的 `runtime_config` 中显式含该字段 → 检查（CLI 走 root admin 放行）

- **备选（落库值 ≠ 默认值才检查）**：更宽松（显式写默认值放行），但需定义"默认值"（network 缺省 false、command 有默认注入）且比较逻辑分散 → 否决。显式设置即检查语义清晰、实现集中、收紧预期明确

### D3: 资源上限 = settings-registry 新增 4 个 integer 设置项（用户选定）

`judge_max_evaluator_time_limit_ms` / `judge_max_evaluator_memory_limit_mb` / `judge_max_solution_call_timeout_ms` / `judge_max_solution_memory_limit_mb`，默认 `0` = 不限制，`>0` 时启用。设置值 `>0` 时，请求中对应字段值超过上限 → 拒绝。

- **备选 A（做成权限项）**：资源限制是硬性安全约束而非授权问题，收紧语义（谁可以设大值）与"全局上限"（谁都不可超限）不同 → 用户明确否决
- **备选 B（单个 JSON 设置项）**：settings-registry 类型系统只支持 boolean/string/text/integer，JSON 需字符串解析与手动校验 → 4 个独立 integer 项更贴合现有机制，管理 UI 自动渲染

### D4: 共享守卫 `src/services/problem-field-guard.ts`

```ts
// 敏感字段 → 权限项 静态映射（未来新增敏感字段只需在此扩展）
const SENSITIVE_FIELD_PERMISSIONS: Record<string, PermissionName> = {
  "evaluator.command": "problem:field_evaluator_command",
  "evaluator.network": "problem:field_evaluator_network",
};
// 资源限制字段 → 设置项 key 静态映射
const RESOURCE_LIMIT_SETTINGS: Record<string, string> = {
  "evaluator.time_limit_ms": "judge_max_evaluator_time_limit_ms",
  "evaluator.memory_limit_mb": "judge_max_evaluator_memory_limit_mb",
  "solution.call_timeout_ms": "judge_max_solution_call_timeout_ms",
  "solution.memory_limit_mb": "judge_max_solution_memory_limit_mb",
};
```

`assertSensitiveFieldPermissions(c, userId, userRole, runtimeConfig)`：遍历请求中**显式存在**（值非 null/undefined）的敏感字段 → 有 Context 时走 `checkPermission` + 显式 `FORBIDDEN` code；CLI 无 Context 场景 **fail-closed**：仅 root 用户（显式 userId 或缺省默认，与 `createProblem` 的 owner 缺省语义一致）与显式 `userRole: "admin"` 放行，其余拒绝（与既有 `c ? assertPermission : userRole` 拒绝模式一致）。

`enforceResourceLimits(runtimeConfig)`：读取设置（`getSetting`），值 `>0` 时校验请求中对应字段，超限抛 `AppError(400, "RESOURCE_LIMIT_EXCEEDED")`。

三条路径在 `validateRuntimeConfig` 之后、落库之前统一调用，保证行为一致。

### D5: 权限项命名与种子

- `problem:field_evaluator_command`（"设置/修改题目评测命令"）、`problem:field_evaluator_network`（"设置/修改题目评测联网配置"），沿用 `resource:action` 约定，`field_` 前缀标识字段级权限
- 加入 `PERMISSION_DEFS`（types/index.ts），默认授权走 `ensureSensitiveFieldDefaultPermissions()`（seed-rbac.ts，一次性 + 内部标记），`ensureRbacSeeds` 启动期补齐，无需迁移

### D6: 错误响应约定

- 无敏感字段权限 → HTTP 403（`FORBIDDEN`，沿用 `assertPermission` 的 `ForbiddenError`）
- 资源超限 → HTTP 400（`RESOURCE_LIMIT_EXCEEDED`），错误信息含上限值与实际值

## Risks / Trade-offs

- [未来新增敏感字段遗漏检查] → 字段映射集中在 guard 单文件，新增字段只需加映射 + 测试；OpenSpec spec 明确定义扩展点
- [管理员移除 user 角色权限后，未分配其他角色的新注册用户立即失去能力] → 这是收紧的预期语义；admin 可在角色管理 UI 中精确控制；文档明示
- [资源上限收紧后存量题目超限] → 仅写入时校验，存量不受影响；更新触及字段时才可能被拒（管理员可按需放宽上限）
- [显式设置即检查可能误伤"显式写默认值"场景] → 语义明确且安全侧收紧；文档与错误信息说明
- [CLI 导入路径的权限退化分支与未来 Context 改造耦合] → 复用既有 `isAdminActor` 退化模式，不引入新机制

## Migration Plan

- 无 DB schema 迁移；发布后启动期 `ensureRbacSeeds()` 自动补齐权限项与 default 角色授权（幂等）
- 资源上限默认 0（不限制），管理员按需配置，无需回滚脚本；回滚 = 撤销代码变更（权限种子幂等，不会残留破坏性数据）
- 行为变化仅在"权限被收紧 / 上限被配置"后出现，默认部署与现状完全一致
