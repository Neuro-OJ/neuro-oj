## Context

noj-core 当前仅暴露公开只读的题目接口（`GET /api/v1/problems`、`GET /api/v1/problems/:id`）和用户认证接口。`users.role` 字段已存在但仅作为数据保留，没有任何路由检查管理员权限。Phase 1 需要在此基础上补齐题目管理、难度标签、分类体系三个能力，为管理后台和题目筛选页提供 API。

当前相关现状：
- `problems` 表已有 `difficulty` 字段（`text`，默认 `'medium'`），无约束。
- `users` 表已有 `role` 字段（`text`，默认 `'user'`），JWT payload 和 `authMiddleware` 已传递 `userRole`。
- 种子脚本 `scripts/seed.ts` 仅插入样例题，不创建管理员账号。
- 没有独立的分类表或题目-分类关联表。

## Goals / Non-Goals

**Goals：**
- 提供管理员专属的题目 CRUD 接口。
- 将 `difficulty` 限制为 `easy` / `medium` / `hard` 三级，并在列表支持按难度筛选。
- 引入树形分类表与多对多关联，支持分类 CRUD 与按分类筛选题目。
- 题目列表支持关键词搜索（标题 + 描述）。
- 通过种子脚本创建初始管理员，并通过管理员提升 API 扩展管理员。
- 所有变更均包含对应的 Drizzle schema、手动 SQL 迁移和测试。

**Non-Goals：**
- 不修改提交/评测流程。
- 不实现对象存储迁移，`support_package_path` 仍指向文件系统路径。
- 不实现复杂的 RBAC（多角色、细粒度权限），仅区分 `admin` 与 `user`。
- 不实现分类的拖拽排序、权重、图标等附加属性。
- 不实现题目版本历史。

## Decisions

### 1. 分类表采用自引用树结构

使用 `categories` 自引用表（`parent_id` 指向同表）实现多级分类，配合 `level` 字段缓存层级深度，避免递归计算。

- 路径简化：前端按分类浏览时通常只需要展示某一级或某一分支；`level` 字段便于按层级过滤。
- 树结构在应用层组装，避免递归 SQL（项目规模下内存组装足够简单）。
- 删除分类时，由数据库 `ON DELETE SET NULL` 将子分类的 `parent_id` 置空，避免级联误删。

**替代方案**：闭包表（closure table）或物化路径（materialized path）。对于当前题目分类这类浅层级、读多写少的场景，闭包表会增加写复杂度，物化路径会破坏 slug 唯一性约束；自引用树是性价比最高的选择。

### 2. 题目与分类多对多关联

新增 `problems_categories` 关联表，复合主键 `(problem_id, category_id)`，并设置 `ON DELETE CASCADE`。

- 一道题可能属于多个分类（例如同时属于 "数据结构" 和 "树"）。
- 删除题目时自动清理关联，删除分类时也自动清理关联。

### 3. 难度约束放在数据库 CHECK + 服务层双重校验

数据库层通过 `CHECK (difficulty IN ('easy', 'medium', 'hard'))` 保证数据完整性；服务层在创建/更新题目时提前校验，返回友好的 400 错误。

- 数据库约束是最后一道防线，防止非法值通过脚本或未来接口写入。
- 服务层校验可在错误时返回中文业务错误信息。

### 4. 管理员鉴权采用组合中间件

新增 `adminMiddleware`，它只检查 `c.get("userRole") === "admin"`，不重复实现 JWT 验证。路由处组合使用 `authMiddleware, adminMiddleware`。

- 与 `authMiddleware` 解耦，保持单一职责。
- 若认证失败，`authMiddleware` 已返回 401，`adminMiddleware` 不会执行。

### 5. 管理员提升 API 需要现有管理员 JWT

种子脚本根据 `ADMIN_EMAIL` 环境变量将已注册用户提升为管理员；之后的管理员提升通过 `PATCH /api/v1/admin/users/:id/role` 完成，必须由现有管理员 JWT 调用。

- 避免引入独立的 bootstrap token，减少环境配置复杂度。
- 第一个管理员必须先注册再通过 seed 提升，保证操作可追溯。

### 6. 关键词搜索使用 PostgreSQL `ILIKE`

题目列表的关键词筛选在 `title` 和 `description` 上使用 `ILIKE '%keyword%'`。

- 当前数据量下足够简单，无需引入全文搜索引擎。
- 后续若搜索成为瓶颈，可迁移到 `tsvector` 或外部搜索服务。

### 7. 手写 SQL 迁移

沿用项目现有模式：在 `drizzle/` 目录新增 `0001_problem_categories.sql`，并在 `src/db/schema.ts` 同步更新 Drizzle 定义。

- 与现有 `0000_initial.sql` 保持一致。
- 便于人工审查 schema 变更。

## Risks / Trade-offs

- **[Risk]** `difficulty` 列添加 CHECK 约束后，如果现有数据包含非法值，迁移会失败。
  - **Mitigation**：当前样例题 `difficulty` 为 `'easy'`，符合约束；迁移前可先运行 `SELECT DISTINCT difficulty FROM problems;` 检查。CI 中已有数据均符合。
- **[Risk]** 删除分类时子分类 `parent_id` 被置空，可能导致分类树出现孤立顶级分类。
  - **Mitigation**：服务层删除分类前，先递归删除或迁移子分类；数据库约束仅作为兜底。
- **[Risk]** 关键词搜索 `ILIKE` 在大数据量下性能下降。
  - **Mitigation**：当前 Phase 1 数据量可控；后续可添加 GIN 索引或迁移到全文搜索。
- **[Risk]** 管理员提升 API 被滥用。
  - **Mitigation**：仅允许现有管理员调用；审计日志在后续 Phase 中补充。
- **[Risk]** 分类树在内存组装，层级很深时可能递归过深。
  - **Mitigation**：业务上分类层级通常不超过 3-4 层；服务层可设置最大层级限制。
