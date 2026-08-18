## Why

当前 NOJ 只有 admin 管控的分类树，用户无法自主组织题目、形成系统刷题路径。对标 HydroOJ `training` / 洛谷题单的基础形态，为用户提供可创建、可排序、可跟踪 AC 进度的题单能力，是 LMCC 备考与日常刷题的核心学习路径载体。

## What Changes

- 新增 `trainings` 题单主表与 `training_problems` 题单题目关联表（Drizzle 迁移）。
- 新增题单 CRUD API：公开列表、我的题单、详情、更新、删除。
- 新增题单题目管理 API：加题、批量重排、移除；题目删除时关联自动清理。
- 新增 AC 进度聚合：编程题 `Accepted` 与客观题满分（`score=10000`）视为已通过。
- 新增 RBAC 权限族 `training:*`，默认 user 角色获得 `create/read/write_own/delete_own`，`publish/pin` 默认仅管理员。
- 新增前端页面：题单列表、我的题单、题单详情、后台题单管理；用户主页与题目页增加入口。
- 可见性采用三态：`private`（仅创建者）、`unlisted`（URL 可访问）、`public`（管理员设置后出现在题单列表）。

## Capabilities

### New Capabilities

- `training-plans`: 用户可创建与管理扁平题单，支持按序收录题目、AC 进度展示与三态可见性。

### Modified Capabilities

<!-- 无既有 spec 的需求变更 -->

## Impact

- **noj-core**：新增 `src/db/schema.ts` 表定义、迁移、`src/types/trainings.ts`、`src/services/trainings.ts`、`src/routes/trainings.ts`、`src/routes/admin-trainings.ts`、RBAC 权限种子。
- **noj-ui**：新增题单相关页面与组件、`composables/useTrainings.ts`；修改用户主页与题目详情页。
- **noj-tests**：新增 training E2E 测试。
- **API**：新增 `/api/v1/trainings` 与 `/api/v1/admin/trainings` 路由。
- **依赖**：无新增外部依赖。
