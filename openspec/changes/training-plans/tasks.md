## 1. 数据模型与类型

- [ ] 1.1 在 `noj-core/src/db/schema.ts` 新增 `trainings` 与 `training_problems` 表定义
- [ ] 1.2 运行 `deno task db:generate` 生成 Drizzle 迁移并应用
- [ ] 1.3 新建 `noj-core/src/types/trainings.ts`，定义可见性枚举、Create/Update/TrainingResponse/TrainingProblemResponse 类型

## 2. 后端 Service

- [ ] 2.1 实现 `services/trainings.ts` 的 CRUD 与可见性访问（listPublicTrainings / listMyTrainings / listAllTrainings / listUserTrainings / getTraining / createTraining / updateTraining / deleteTraining）
- [ ] 2.2 实现题单题目管理（listTrainingProblems / addTrainingProblem / reorderTrainingProblems / removeTrainingProblem）
- [ ] 2.3 实现 AC 进度聚合（编程题 Accepted + 客观题满分）
- [ ] 2.4 编写并跑通 `tests/services/trainings.test.ts`

## 3. RBAC 权限

- [ ] 3.1 在 `PERMISSION_DEFS` 注册 9 项 `training:*` 权限
- [ ] 3.2 在 `USER_DEFAULT_PERMISSIONS` 为 user 角色添加 `training:create/read/write_own/delete_own`
- [ ] 3.3 编写并跑通 RBAC training 权限种子测试

## 4. 后端 API

- [ ] 4.1 新建 `routes/trainings.ts` 并挂载 `/api/v1/trainings`
- [ ] 4.2 实现公开列表、`?created_by=` 用户题单列表、`/mine`、CRUD、题目管理端点
- [ ] 4.3 新建 `routes/admin-trainings.ts` 并挂载 `/api/v1/admin/trainings`
- [ ] 4.4 实现后台全部题单列表、PATCH（含 public/pin）、DELETE
- [ ] 4.5 编写并跑通 `tests/routes/trainings.test.ts` 与 `tests/routes/admin-trainings.test.ts`

## 5. 前端

- [ ] 5.1 新建 `noj-ui/types/training.ts` 与 `composables/useTrainings.ts`
- [ ] 5.2 新建题单列表页 `/trainings`、我的题单页 `/trainings/mine` 及 TrainingCard/TrainingFormModal 组件
- [ ] 5.3 新建题单详情页 `/trainings/[id]` 与 TrainingProblemList/TrainingProblemManager 组件
- [ ] 5.4 用户主页增加“我的题单”区块，题目详情页增加“加入题单”入口
- [ ] 5.5 新建后台 `/admin/trainings` 页面与 TrainingManagementSection 组件
- [ ] 5.6 跑通 `deno lint` / `deno fmt` / `nuxt build`

## 6. E2E 与收尾

- [ ] 6.1 新建 `noj-tests/e2e/trainings.test.ts` 覆盖建题单、加题、进度、可见性、删题清理
- [ ] 6.2 运行 noj-core 全量测试、noj-ui 构建、noj-tests training E2E
- [ ] 6.3 确认设计文档、实施计划与 OpenSpec 变更齐全
