## 1. 数据库 Migration

- [x] 1.1 创建 `drizzle/0004_problem_owner_type.sql`：添加 owner_id、type、number 字段，CHECK 和 UNIQUE 约束
- [x] 1.2 更新 `src/db/schema.ts`：problems 表追加 number(integer)、owner_id(text)、type(text) 字段

## 2. Root 系统用户

- [x] 2.1 在 `src/services/auth.ts` 中新增 `ensureRootUser()` 函数（id='0'、username='root'、role='admin'、随机密码）
- [x] 2.2 在 `src/main.ts` 的 `runMigrations()` 后调用 `ensureRootUser()`
- [x] 2.3 修改 `listUsers()` 服务函数，排除 id='0' 的 root 用户

## 3. 错误类与类型定义

- [x] 3.1 在 `src/lib/errors.ts` 中新增 `ForbiddenError` 类（HTTP 403）
- [x] 3.2 在 `src/types/problems.ts` 中新增 `ProblemType`、`PROBLEM_TYPES`、`isValidProblemType()`、CreateProblemInput/ProblemListQuery/ProblemResponseWithCategories 追加 owner_id/type/number/display_id 字段

## 4. 服务层权限与编号逻辑

- [x] 4.1 修改 `createProblem()`：接收 userId/userRole；admin 可创建任意 type，普通用户仅限 U 型；自动设 owner_id；U 型 MAX+1 自增
- [x] 4.2 修改 `updateProblem()`：接收 userId/userRole；基于 type+owner 权限判断；禁止修改 type/number
- [x] 4.3 修改 `deleteProblem()`：接收 userId/userRole；U 型 owner 可删，P 型仅 admin
- [x] 4.4 修改 `listProblems()`：新增 type、number 查询条件
- [x] 4.5 修改 `getProblem()` 和内部映射函数：新增 display_id 计算 (`${type}${number}`)
- [x] 4.6 新增 `getProblemByTypeAndNumber(type, number)`：按组合唯一索引查找

## 5. 路由层调整

- [x] 5.1 修改 `POST /problems`：移除 adminMiddleware，从 context 获取 userId/userRole 传参
- [x] 5.2 修改 `PUT /problems/:id`：移除 adminMiddleware，双索引解析 :id 后传参
- [x] 5.3 修改 `DELETE /problems/:id`：移除 adminMiddleware，双索引解析 :id 后传参
- [x] 5.4 新增 `resolveProblem(id)` 工具函数：先按 UUID 查找，解析 display_id fallback
- [x] 5.5 修改 `GET /problems`：新增 type、number 查询参数解析

## 6. Seed 脚本更新

- [x] 6.1 修改 `scripts/seed.ts`：SampleProblem 加入 number/owner_id/type 字段，插入时补充 P 型数据

## 7. 测试补充

- [x] 7.1 新增服务层测试（20 个新测试用例：权限、类型筛选、双索引查找、所有者操作）
- [x] 7.2 新增路由测试（7 个新测试用例：display_id 解析、类型筛选、用户/管理员 CRUD）
- [x] 7.3 运行 `deno task test` 确保全部通过（176 passed | 0 failed）

## 8. OpenSpec 规范同步

- [x] 8.1 通过 `/opsx:sync` 同步 delta specs 到主 spec 目录

## 9. 前端（noj-ui）改动

- [x] 9.1 修改 `composables/useProblemFilters.ts`：新增 type 筛选状态
- [x] 9.2 修改 `components/ProblemFilterBar.vue`：新增类型筛选按钮组
- [x] 9.3 修改 `pages/problems.vue`：题号列改 display_id、新增类型标签列
- [x] 9.4 修改 `pages/problems/[id].vue`：显示 display_id/类型标签/所有者，权限按钮控制
- [x] 9.5 修改 `pages/admin/problems.vue`：表格新增 display_id/类型/所有者列
- [x] 9.6 修改 `pages/admin/problem-new.vue`：新增类型选择器和题号输入
- [x] 9.7 修改 `pages/admin/problem-edit/[id].vue`：类型和题号只读展示
- [x] 9.8 新建 `pages/my/problems.vue` + `middleware/auth.ts`：用户自己的 U 型题目管理页
