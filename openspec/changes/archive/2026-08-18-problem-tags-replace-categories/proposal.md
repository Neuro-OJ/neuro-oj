## Why

NOJ 目前的题目组织维度只有 admin 管控的分类树（`categories` + `problems_categories`），缺少对标 HydroOJ / 洛谷的轻量标签维度，题目列表无法按算法属性筛选。经过设计讨论（issue #223 评论区 + 本地 brainstorming），决定将定位从「标签与分类互补」升级为「**分类系统整体退役，由双类标签系统取代**」：标签分为题目标签（人人可见）与算法标签（通过题目后可见，洛谷式 spoiler 模型）。

## What Changes

- **BREAKING** 删除 `categories` / `problems_categories` 表、`/api/v1/categories` 全部接口、`category:read`/`category:manage` RBAC 权限、`/admin/categories` 管理页与分类相关 spec；存量分类数据不迁移，seed 重打样例题标签。
- **BREAKING** 题目接口字段替换：`category_ids` → `tag_ids`（创建/更新）、`?category_id=` → `?tag=`（列表筛选）、详情响应 `categories` → `tags` + `has_hidden_algorithm_tags`。
- 新增 `tags` 表（`id` / `name` 全局唯一 / `kind`(`problem`|`algorithm`) / `created_at` / `updated_at`）与 `problem_tags` 多对多关联表（级联删除）。
- 客观题（`is_objective=true`）禁止关联算法标签（打标校验 400）——客观题系统无「通过」概念，从根上消除门控歧义。
- 新增标签 API：`GET /api/v1/tags` 公开（每项含 `id`/`name`/`kind`/`problem_count`，按 name 升序）；`POST/PUT/DELETE /api/v1/tags`、`POST /api/v1/tags/:id/merge` 仅拥有 `tag:manage` 权限的用户（默认仅 admin，可配置）。
- 打/去标签沿用题目 CRUD 全量替换语义（admin + U 型题 owner）；**标签新建/修改/删除/合并默认仅 admin**（`tag:manage` RBAC 权限判定，不硬编码 admin；默认不授予任何角色，运营者可经角色管理授予自定义角色）。
- 算法标签可视性门控（后端强制）：题目详情仅向 admin / 题主 / 有 Accepted 提交的 viewer 返回算法标签；其余返回占位标志 `has_hidden_algorithm_tags=true`。列表接口只返回题目标签。
- 洛谷式发现路径：`?tag=` 筛选与全局搜索对所有人可按算法标签发现题目（接受反向暴露 tradeoff）。
- 全局搜索匹配标签名（两种 kind）；导入 manifest `categories` → `tags`；dashboard `total_categories` → `total_tags`；审计日志 `categories.delete` → `tags.*`。
- 新增 `/admin/tags` 管理页（CRUD + 合并 + kind 管理），删除 `/admin/categories`。

## Capabilities

### New Capabilities

- `problem-tags`: 标签数据模型、标签 CRUD/合并 API（`tag:manage` RBAC 判定，默认仅 admin、可配置）、题目-标签关联与全量替换语义、双类标签（problem/algorithm）与算法标签可视性门控规则、`?tag=` 列表筛选、全局搜索标签名匹配。
- `admin-tag-management`: `/admin/tags` 管理页（列表/创建/重命名/改 kind/合并/删除），admin 专属。

### Modified Capabilities

- `category-management`: 整体退役——分类树 API 全部移除（REMOVED）。
- `admin-category-management`: 整体退役——`/admin/categories` 页面移除（REMOVED）。
- `problem-management`: 题目载荷 `category_ids` → `tag_ids`；列表筛选 `category_id` → `tag`；详情响应 `categories` → `tags` + `has_hidden_algorithm_tags`。
- `problem-list-page`: 表格「分类」列 → 「标签」列（仅题目标签）；筛选下拉 `GET /categories` → `GET /tags`，URL 参数 `category_id` → `tag`。
- `database-schema`: 删除 `categories`/`problems_categories`，新增 `tags`/`problem_tags`；权限预置五个资源域中 category → tag。
- `rbac-core`: `category:read`/`category:manage` → `tag:read`/`tag:manage`；默认角色权限同步调整。
- `audit-log`: `categories.delete` 动作 → `tags.create`/`tags.update`/`tags.delete`/`tags.merge`。
- `audit-log-e2e`: 分类删除审计场景 → 标签删除/合并审计场景。
- `problem-bundle-import`: manifest `categories` 字段 → `tags` 字段（按 name 解析，缺省忽略 + warning）。
- `global-search`: 题目搜索匹配标签名（两种 kind）。
- `admin-problem-management`: 管理端题目列表筛选参数 `category_id` → `tag`。
- `admin-dashboard`: `total_categories` 统计 → `total_tags`。
- `admin-ip-blacklist`: 管理页风格参考文件由 `pages/admin/categories.vue` → `pages/admin/tags.vue`。

## Impact

- **数据库**: 新迁移 DROP `problems_categories`/`categories`，CREATE `tags`/`problem_tags`，清理 `category:*` 权限行；`seed-system.ts` `seedCategories()` → `seedTags()`。
- **noj-core**: `schema.ts`、`routes/categories.ts`（删除）、新 `routes/tags.ts`、新 `services/tags.ts`、`problems-categories.ts` → `problems-tags.ts`、`problems-crud.ts`、`problems-list.ts`、`problems-types.ts`、`types/problems.ts`、`search.ts`、`problem-bundle.ts`、`dashboard.ts`、`seed-rbac.ts`、`app.ts`。
- **noj-ui**: `ProblemFilterBar`、`useProblemFilters`、`pages/problems.vue`、`pages/problems/[id].vue`、`ProblemCard`、`CodingProblemEditor`、`EditorWorkspace`、`EditorSidebar`、`RandomProblems`、`pages/my/problems.vue`、`pages/admin/problems.vue`、`pages/admin/categories.vue`（删除）、新 `pages/admin/tags.vue`、`layouts/admin.vue`、`pages/admin/audit-logs.vue`。
- **样例数据**: `data/problems-src/{1001,1003}/problem.json` 的 `categories` → `tags`。
- **测试**: core 单测（categories → tags，含门控四态用例）、smoke、noj-tests E2E（`01_categories.test.ts` → 标签版 + 门控场景）、`12_audit_log.test.ts`。
- **无评测引擎改动**：noj-judge 不受影响。
