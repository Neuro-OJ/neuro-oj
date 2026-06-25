## 1. 数据库 Migration

- [ ] 1.1 创建 `drizzle/0004_problem_owner_type.sql`：添加 owner_id、type、number 字段，CHECK 和 UNIQUE 约束
- [ ] 1.2 更新 `src/db/schema.ts`：problems 表追加 number(integer)、owner_id(text)、type(text) 字段

## 2. Root 系统用户

- [ ] 2.1 在 `src/services/auth.ts` 中新增 `ensureRootUser()` 函数（id='0'、username='root'、role='admin'、随机密码）
- [ ] 2.2 在 `src/main.ts` 的 `runMigrations()` 后调用 `ensureRootUser()`
- [ ] 2.3 修改 `listUsers()` 服务函数，排除 id='0' 的 root 用户

## 3. 错误类与类型定义

- [ ] 3.1 在 `src/lib/errors.ts` 中新增 `ForbiddenError` 类（HTTP 403）
- [ ] 3.2 在 `src/types/problems.ts` 中新增 `ProblemType`、`PROBLEM_TYPES`、`isValidProblemType()`、CreateProblemInput/ProblemListQuery/ProblemResponseWithCategories 追加 owner_id/type/number/display_id 字段

## 4. 服务层权限与编号逻辑

- [ ] 4.1 修改 `createProblem()`：接收 userId/userRole；admin 可创建任意 type，普通用户仅限 U 型；自动设 owner_id；U 型 MAX+1 自增
- [ ] 4.2 修改 `updateProblem()`：接收 userId/userRole；基于 type+owner 权限判断；禁止修改 type/number
- [ ] 4.3 修改 `deleteProblem()`：接收 userId/userRole；U 型 owner 可删，P 型仅 admin
- [ ] 4.4 修改 `listProblems()`：新增 type、number 查询条件
- [ ] 4.5 修改 `getProblem()` 和内部映射函数：新增 display_id 计算 (`${type}${number}`)
- [ ] 4.6 新增 `getProblemByTypeAndNumber(type, number)`：按组合唯一索引查找

## 5. 路由层调整

- [ ] 5.1 修改 `POST /problems`：移除 adminMiddleware，从 context 获取 userId/userRole 传参
- [ ] 5.2 修改 `PUT /problems/:id`：移除 adminMiddleware，双索引解析 :id 后传参
- [ ] 5.3 修改 `DELETE /problems/:id`：移除 adminMiddleware，双索引解析 :id 后传参
- [ ] 5.4 新增 `resolveProblem(id)` 工具函数：先按 UUID 查找，解析 display_id fallback
- [ ] 5.5 修改 `GET /problems`：新增 type、number 查询参数解析

## 6. Seed 脚本更新

- [ ] 6.1 修改 `scripts/seed.ts`：SampleProblem 加入 number/owner_id/type 字段，插入时补充 P 型数据

## 7. 测试补充

- [ ] 7.1 新增服务层测试：普通用户创建 U/P 型、所有者编辑/删除、非所有者权限拒绝、编号自增
- [ ] 7.2 新增路由测试：双索引路由、type/number 筛选、display_id 响应字段
- [ ] 7.3 运行 `deno task test` 确保全部通过

## 8. OpenSpec 规范更新

- [ ] 8.1 检查并更新 `openspec/specs/database-schema/spec.md`：新字段定义
- [ ] 8.2 检查并更新 `openspec/specs/problem-management/spec.md`：权限模型变更
- [ ] 8.3 检查并更新 `openspec/specs/admin-authorization/spec.md`：root 用户、权限下沉
- [ ] 8.4 检查并更新 `openspec/specs/admin-problem-management/spec.md`：UI 适配
- [ ] 8.5 检查并更新 `openspec/specs/problem-list-page/spec.md`：类型筛选
- [ ] 8.6 移动 delta specs 到主 spec 目录（用 /opsx:sync）

## 9. 前端（noj-ui）改动

- [ ] 9.1 修改 `composables/useProblemFilters.ts`：新增 type/number 筛选状态
- [ ] 9.2 修改 `components/ProblemFilterBar.vue`：新增类型筛选按钮组
- [ ] 9.3 修改 `pages/problems.vue`：题号列改 display_id、新增类型标签列
- [ ] 9.4 修改 `pages/problems/[id].vue`：显示 display_id/类型标签/所有者，权限按钮控制
- [ ] 9.5 修改 `pages/admin/problems.vue`：表格新增 display_id/类型/所有者列
- [ ] 9.6 修改 `pages/admin/problem-new.vue`：新增类型选择器和题号输入
- [ ] 9.7 修改 `pages/admin/problem-edit/[id].vue`：类型和题号只读展示
- [ ] 9.8 新建 `pages/my/problems.vue`：用户自己的 U 型题目管理页
