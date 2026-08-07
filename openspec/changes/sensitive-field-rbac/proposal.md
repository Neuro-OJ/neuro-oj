## Why

当前题目 `runtime_config`（problem.json）的敏感字段权限与题目创建/编辑权限整体绑定——如 `evaluator.network.enabled`（联网开关）只要拥有题目创建权限即可开启，无法按需收紧或下放。同时资源限制字段（`time_limit_ms` / `memory_limit_mb` / `call_timeout_ms`）无全局上限，出题人可任意设置超长时限/超大内存。需要一个通用的、可配置的机制按字段管控敏感配置（issue #207）。

## What Changes

- 将 `runtime_config` 中的高危敏感字段（`evaluator.command`、`evaluator.network.enabled`）抽离为独立 RBAC 权限项（`problem:field_evaluator_command`、`problem:field_evaluator_network`），权限检查服务端强制
- 新权限项默认授予 default user 角色（默认放行），保证现有行为与存量题目不受影响；管理员通过角色管理按需移除授权即收紧，无权限用户设置/修改对应字段被拒绝（403）
- 资源限制字段（`evaluator.time_limit_ms`、`evaluator.memory_limit_mb`、`solution.call_timeout_ms`、`solution.memory_limit_mb`）改为管理员后台可配置的全局上限（settings-registry 新增设置项，默认 0 = 不限制），超限拒绝写入
- 创建（POST /problems）、更新（PUT /problems/:id）、题目包导入（POST /problems/import-bundle + CLI）三条写入路径行为一致，共用同一守卫函数
- 权限检查仅在请求中显式设置对应字段时触发（PATCH 部分更新不触及字段则放行）；读取路径不变（issue 验收仅覆盖写入）

## Capabilities

### New Capabilities
- `sensitive-field-permissions`: 题目敏感字段的独立 RBAC 权限项机制——权限项定义、默认授权（default 角色）、字段写入时的服务端强制检查（创建/更新/导入三条路径一致）
- `problem-resource-limits`: 题目资源限制字段的管理员全局上限配置——设置项定义、写入时超限拒绝（三条路径一致）

### Modified Capabilities
- `problem-runtime-config`: 写入 `runtime_config` 时需遵守敏感字段权限检查与资源上限校验，明确字段级授权语义
- `rbac-core`: `PERMISSION_DEFS` 新增题目敏感字段权限项，default user 角色默认授权列表扩展
- `admin-system-settings`: 新增 judge 分类资源上限设置项（4 个 integer 配置，默认 0 = 不限制）
- `problem-bundle-import`: 题目包导入路径执行与 CRUD 相同的敏感字段权限检查与资源上限校验（CLI 走 root 用户天然放行）

## Impact

- **noj-core**：`src/types/index.ts`（PERMISSION_DEFS）、`src/services/seed-rbac.ts`（敏感字段权限项一次性默认授权 + 内部 seed 标记）、`src/lib/settings-registry.ts`（新增设置项）、`src/services/problems-crud.ts` 与 `src/services/problem-bundle.ts`（三条写入路径接入守卫）、新增 `src/services/problem-field-guard.ts`（共享守卫函数）
- **API 行为**：收紧后无权限用户设置敏感字段返回 403（`FORBIDDEN`）；资源超限返回 400（`RESOURCE_LIMIT_EXCEEDED`）；默认配置下行为与现状完全一致
- **管理后台**：设置项与权限项由现有动态渲染自动出现（admin/settings.vue、admin/roles.vue），无 UI 代码改动
- **数据库**：无 schema 变更、无迁移（权限种子幂等补齐，系统设置走既有 settings 机制）
- **兼容性**：存量题目不受影响（仅写入时校验）；CLI 导入（root 用户）不受影响
