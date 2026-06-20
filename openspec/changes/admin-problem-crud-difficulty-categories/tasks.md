## 1. 数据库 Schema 与迁移

- [ ] 1.1 在 `src/db/schema.ts` 新增 `categories` 表（字段：id, name, slug, description, parent_id, level, created_at, updated_at）与 `problemsCategories` 关联表（复合主键 problem_id + category_id）。
- [ ] 1.2 在 `src/db/schema.ts` 为 `problems.difficulty` 添加 Drizzle 枚举约束（使用 `CHECK` 等效实现），并同步新增 difficulty 与分类相关索引。
- [ ] 1.3 新增 `drizzle/0001_problem_categories.sql` 迁移文件：创建两张新表、添加外键与索引、为 `problems.difficulty` 添加 CHECK 约束。
- [ ] 1.4 运行 `deno task migrate` 验证迁移在本地 PostgreSQL 可成功执行。

## 2. 管理员鉴权

- [ ] 2.1 在 `src/middleware/auth.ts` 新增 `adminMiddleware`，检查 `c.get("userRole") === "admin"`，非管理员返回 403。
- [ ] 2.2 在 `src/services/auth.ts` 新增 `promoteUser(userId, role)` 服务函数，验证目标用户存在且角色值为 `admin` 或 `user`。
- [ ] 2.3 在 `src/routes/auth.ts` 新增 `PATCH /api/v1/admin/users/:id/role` 路由，使用 `authMiddleware` + `adminMiddleware`，解析 JSON body 中的 `role` 并调用 `promoteUser`。
- [ ] 2.4 在 `src/app.ts` 注册新的路由组（或复用 `auth` 路由）确保管理员提升端点可访问。

## 3. 分类管理

- [ ] 3.1 在 `src/services/categories.ts` 实现分类服务：
  - `listCategories()`：查询全部并按树形组装返回。
  - `getCategory(id)`：单条查询，不存在抛 `NotFoundError`。
  - `createCategory(input)`：创建分类，校验 `parent_id` 存在性与 `slug` 唯一性，自动计算 `level`。
  - `updateCategory(id, input)`：更新分类，禁止循环父子关系。
  - `deleteCategory(id)`：仅允许删除无子分类的分类。
- [ ] 3.2 在 `src/routes/categories.ts` 实现路由：
  - `GET /`：公开读取分类树。
  - `POST /`、`PUT /:id`、`DELETE /:id`：使用 `authMiddleware` + `adminMiddleware` 保护。
- [ ] 3.3 在 `src/app.ts` 注册 `/api/v1/categories` 路由。

## 4. 题目管理

- [ ] 4.1 在 `src/types/index.ts`（或新建 `src/types/problems.ts`）定义题目创建/更新输入类型与允许的难度常量。
- [ ] 4.2 在 `src/services/problems.ts` 新增：
  - `createProblem(input)`：创建题目，校验 `difficulty`，处理 `category_ids` 关联。
  - `updateProblem(id, input)`：全量更新题目与分类关联。
  - `deleteProblem(id)`：删除题目并级联删除分类关联。
  - 扩展 `listProblems(page, limit, filters)`：支持 `difficulty`、`category_id`、`keyword` 筛选。
- [ ] 4.3 在 `src/routes/problems.ts` 新增：
  - `POST /`：`authMiddleware` + `adminMiddleware`。
  - `PUT /:id`：`authMiddleware` + `adminMiddleware`。
  - `DELETE /:id`：`authMiddleware` + `adminMiddleware`。
  - 扩展 `GET /`：读取查询参数并传入服务层。
- [ ] 4.4 确保 `GET /api/v1/problems/:id` 返回的分类信息可选（可单独提供 `GET /api/v1/problems/:id/categories` 或在详情中嵌入 `categories` 数组）。

## 5. 种子脚本

- [ ] 5.1 扩展 `scripts/seed.ts`：
  - 读取环境变量 `ADMIN_EMAIL`，若存在则将对应用户 `role` 更新为 `admin`。
  - 初始化示例分类（如 "算法" / "数据结构" / "树"）。
  - 将样例题 1001 关联到示例分类。
- [ ] 5.2 在 `.env.example`（如存在）或 `README.md` 中补充 `ADMIN_EMAIL` 说明。

## 6. 测试

- [ ] 6.1 新增/更新 `tests/middleware/auth.test.ts`：覆盖 `adminMiddleware` 的 403 场景。
- [ ] 6.2 新增 `tests/services/categories.test.ts`：覆盖分类 CRUD、树组装、slug 冲突、循环父子关系。
- [ ] 6.3 新增 `tests/routes/categories.test.ts`：覆盖公开读取与管理员写操作鉴权。
- [ ] 6.4 更新 `tests/services/problems.test.ts`：覆盖题目 CRUD、难度校验、分类关联、筛选逻辑。
- [ ] 6.5 更新 `tests/routes/problems.test.ts`：覆盖创建/更新/删除鉴权、列表筛选参数。
- [ ] 6.6 新增 `tests/routes/auth-admin.test.ts`（或扩展 `tests/routes/auth.test.ts`）：覆盖管理员提升接口的权限与参数校验。
- [ ] 6.7 运行 `deno task test` 确保全部测试通过。

## 7. 验证与收尾

- [ ] 7.1 运行 `deno fmt` 与 `deno lint` 修复格式与 lint 问题。
- [ ] 7.2 本地启动服务，使用 curl 或 HTTP 客户端验证：管理员登录 → 创建分类 → 创建题目 → 按难度/分类/关键词筛选 → 提升另一用户为管理员 → 删除题目/分类。
- [ ] 7.3 更新 `openspec/specs/` 主规范（可选，若需要同步），或在归档时通过 `/opsx:archive` 处理。
