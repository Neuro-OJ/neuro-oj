# 实施任务：题目标签系统（category 退役）

> 依赖设计文档 `design.md` 与 specs delta。实现顺序：数据库 → core 服务 → core 路由 → core 测试 → UI → E2E → 数据/文档。每步可验证。

## 1. 前置核实

- [ ] 1.1 （已决议，无动作）客观题禁止关联算法标签：`syncProblemTags` 对 `is_objective=true` 题目校验 kind='algorithm' → 400，不核实及格线字段
- [ ] 1.2 全仓复查 `categories`/`category_id`/`categories.delete` 引用面（core/ui/scripts/seed/tests/E2E），与 proposal Impact 清单比对，确认无遗漏消费方
- [ ] 1.3 确认 GPG 签名可用（`gpg --list-secret-keys`、`jj config get signing.key`），未配置则先引导用户配置（AGENTS.md §9.2）
- [ ] 1.4 （已决议）样例标签集：1001 → [LMCC 样例题] + 算法[模拟]；1002 → [LMCC 样例题] + 算法[滑动窗口, 模拟]；1003 → [入门, LMCC 样例题] + 算法[模拟]

## 2. 数据库 Schema 与迁移

- [ ] 2.1 `src/db/schema.ts`：删除 `categories`/`problemsCategories` 定义，新增 `tags`（name UNIQUE + kind CHECK + `created_at`/`updated_at`）与 `problemTags`（复合 PK + 双 CASCADE），FK 不带 schema 前缀
- [ ] 2.2 `deno task db:generate` 生成迁移，人工核对：DROP 分类表、CREATE 标签表、`DELETE FROM permissions/role_permissions WHERE resource='category'`、`audit_logs` 的 action CHECK 约束更新为 10 值（含 tags.*）
- [ ] 2.3 确认 `_journal.json` 由工具生成、未手改；迁移在空库与既有库均可执行

## 3. core 服务层

- [ ] 3.1 新建 `src/services/tags.ts`：`listTags`（含 `problem_count`，按 name 升序）/`createTag`（重名 409）/`updateTag`（维护 `updated_at`）/`deleteTag`（审计 `tags.delete`）/`mergeTags`（事务：重指向 ON CONFLICT DO NOTHING → 删 source → 审计 `tags.merge`；source==target 400）；删除 `src/services/categories.ts`（主分类服务）
- [ ] 3.2 `problems-categories.ts` 重写为 `problems-tags.ts`：`syncProblemTags`（存在性校验 + 全量替换 + **客观题禁止 algorithm kind 校验 400**）；删除旧 `problems-categories.ts`
- [ ] 3.3 `problems-crud.ts`：`category_ids` → `tag_ids`（创建/更新两处）
- [ ] 3.4 `problems-list.ts`：`attachCategories` → `attachTags(problemIds, {kind})`；查询参数 `category_id` → `tag`（沿用两段式 inArray 筛选）；新增 `resolveVisibleTags`（admin/owner/AC 全量，否则裁剪 algorithm kind + 置 `has_hidden_algorithm_tags`；客观题按 1.1 结论）
- [ ] 3.5 `search.ts`：`searchProblems` 列表与 count 两处 WHERE 追加标签名 EXISTS+ILIKE 条件（`escapeLikePattern` 转义）
- [ ] 3.6 `seed-system.ts`：`seedCategories()` → `seedTags()`（固定 id 幂等种子：题目标签 LMCC 样例题/入门；算法标签 模拟/滑动窗口/前缀和/图论/DP/数据结构/树）
- [ ] 3.7 `problem-bundle.ts`：`resolveCategoryIds` → `resolveTagIds`（manifest `tags` 按 name 解析）；同步更新 `scripts/noj.ts` 中「题目-分类关联」注释
- [ ] 3.8 `dashboard.ts`：`total_categories` → `total_tags`（改统计 `tags` 表）
- [ ] 3.9 `seed-rbac.ts`：`category:read/manage` → `tag:read/manage`（权限清单 + user 角色默认关联）
- [ ] 3.10 `problems-types.ts` / `types/problems.ts`：`categories` → `tags` + `has_hidden_algorithm_tags`；输入 `category_ids` → `tag_ids`；查询 `category_id` → `tag`

## 4. core 路由层

- [ ] 4.1 删除 `src/routes/categories.ts`，`app.ts` 取消挂载
- [ ] 4.2 新建 `src/routes/tags.ts`：GET 公开；POST/PUT/DELETE/merge 走 `requirePermission("tag:manage")`（RBAC 判定，**不用硬编码 adminMiddleware**，使权限可配置）；挂载到 `app.ts`
- [ ] 4.3 `routes/problems.ts`：列表参数 `category_id` → `tag`；详情 `GET /:id` 用 `optionalAuthMiddleware` 注入 viewer 并按 `resolveVisibleTags` 裁剪响应
- [ ] 4.4 审计类型：`AuditDetail` 联合类型加入 tags 四动作，移除 `categories.delete`

## 5. core 测试

- [ ] 5.1 删除 `tests/services/categories.test.ts`、`tests/routes/categories.test.ts`
- [ ] 5.2 新建 `tests/services/tags.test.ts`（CRUD/重名 409/merge 去重/删除级联/审计）
- [ ] 5.3 新建 `tests/routes/tags.test.ts`（401/403/400/404/merge；含 RBAC 用例：默认 user 角色写接口 403，自定义角色授予 `tag:manage` 后写接口成功）
- [ ] 5.4 更新 `tests/services/problems.test.ts`、`tests/routes/problems.test.ts`：`tag_ids`、`?tag=` 筛选、可视性门控四态（匿名/普通/AC/admin）、客观题 + algorithm 标签 → 400
- [ ] 5.5 更新 `tests/smoke.test.ts`（`GET /api/v1/tags`）
- [ ] 5.6 `deno fmt` + `deno lint` + `deno task test` 全绿

## 6. noj-ui

- [ ] 6.1 `ProblemFilterBar.vue`：分类 USelect → 标签 USelect（`GET /tags` 按 kind 分组）；emit `update:tagId`
- [ ] 6.2 `useProblemFilters.ts`：URL 参数 `category_id` → `tag`
- [ ] 6.3 `pages/problems.vue`：表格「分类」列 → 「标签」列（仅题目标签）
- [ ] 6.4 `pages/problems/[id].vue`：分类 chips → 标签 chips（点击跳 `/problems?tag=...`）；`has_hidden_algorithm_tags` 渲染「🔒 算法标签 · 通过后显示」占位；提交终态（复用 `useSubmissionPolling` 回调）后重新拉取题目详情，AC 即展示算法标签
- [ ] 6.5 `ProblemCard.vue` / `RandomProblems.vue` / `EditorWorkspace.vue` / `EditorSidebar.vue` / `my/problems.vue` / `admin/problems.vue`：`categories` → `tags`
- [ ] 6.6 `CodingProblemEditor.vue` 与 `pages/editor/[id].vue`：checkbox 组 → 标签多选（搜索已有 + `tag_ids` 提交；「新建标签」仅对拥有 `tag:manage` 的用户可见，调 `POST /tags`）
- [ ] 6.7 删除 `pages/admin/categories.vue`，新建 `pages/admin/tags.vue`（名称/kind/题目数表格 + 创建/重命名/改 kind/合并/删除，删除用 danger 确认）；`layouts/admin.vue` 菜单改「标签管理」
- [ ] 6.8 `pages/admin/audit-logs.vue`：action 映射与详情渲染更新为 tags 四动作
- [ ] 6.9 `deno fmt` + `deno lint` + `nuxt build` 通过

## 7. 样例数据与导入

- [ ] 7.1 `data/problems-src/{1001,1002,1003}/problem.json`：`categories` → `tags`（1001: LMCC 样例题 + 模拟；1002: LMCC 样例题 + 滑动窗口/模拟；1003: 入门/LMCC 样例题 + 模拟）
- [ ] 7.2 `deno task problems:build` 重构建样例包；`deno task dev-setup` 验证种子标签 + 导入 + 打标幂等

## 8. 跨模块 E2E（noj-tests）

- [ ] 8.1 `01_categories.test.ts` → 标签版：admin 建标签 → 打标签 → `?tag=` 筛选命中 → 合并/删除后关联正确 → difficulty+tag 组合筛选
- [ ] 8.2 新增门控场景：未通过用户详情响应含 `has_hidden_algorithm_tags=true` 且无算法标签名；提交 AC 后可见
- [ ] 8.3 更新 `12_audit_log.test.ts`（tags.delete/tags.merge 场景）
- [ ] 8.4 `cd noj-tests && deno task test` 全绿

## 9. 文档与流程收尾

- [ ] 9.1 设计文档 `docs/superpowers/specs/YYYY-MM-DD-problem-tags-design.md`（沉淀 design.md 决策与 spoiler 模型）
- [ ] 9.2 更新 issue #223 评论说明范围变更（category 退役 + 双类标签 + 门控）
- [ ] 9.3 jj 提交（GPG、中文 Conventional Commits）→ PR（不直推 main）
- [ ] 9.4 合并后 `/opsx:archive` 归档本变更（`category-management`/`admin-category-management` spec 移除，新增 `problem-tags`/`admin-tag-management`）
