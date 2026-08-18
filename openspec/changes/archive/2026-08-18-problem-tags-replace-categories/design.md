## Context

NOJ 当前仅有 admin 管控的分类树（`categories`：parent_id 自引用 + level 缓存深度；`problems_categories` 多对多）作为题目组织维度。issue #223 原案是「标签与分类树互补」，但经与维护者讨论后升级定位：**分类系统整体退役，由双类标签系统取代**（洛谷式 spoiler 模型）。

现状关键事实（本次设计依据）：

- 题目列表 `GET /api/v1/problems` 已支持 `difficulty/category_id/keyword/type/number/owner_id` AND 叠加筛选（`services/problems-list.ts`），分类筛选为「先查关联表拿 problem_id → inArray」两段式。
- 题目详情 `GET /api/v1/problems/:id` 已引入 `optionalAuthMiddleware`，可拿到 viewer 身份。
- 「通过」= viewer 在本题存在 `evaluation_results.status = 'Accepted'` 的提交；客观题走独立的 `objective_submissions`（score ×100 整数）。
- RBAC 权限预置 22 条（`rbac-core` spec），含 `category:read`/`category:manage`；题目打分类走 problem CRUD 的 `category_ids` 全量替换（`syncProblemCategories`）。
- 导入 manifest（`problem.json`）按 name 解析 `categories` 数组（`problem-bundle.ts` 的 `resolveCategoryIds`）。
- 全局搜索（`global-search` spec）用 tsvector + trigram + ILIKE，不涉及分类；dashboard `getDashboardStats` 统计 `total_categories`。
- 消费方仅 noj-ui 与 noj-tests（已 grep 核实），无第三方客户端 → 可采用硬破坏性变更，不留兼容层。

## Goals / Non-Goals

**Goals:**

1. 用 `tags`（双 kind：`problem`/`algorithm`）+ `problem_tags` 取代分类树，数据模型与 API 简洁（无树、无 slug/颜色/描述）。
2. 标签管理（CRUD + 合并）admin 专属（`tag:manage`）；打/去标签复用题目 CRUD 全量替换语义（admin + U 型题 owner）；**新建标签仅 admin**。
3. 算法标签可视性门控**在后端强制**：详情接口对非 admin/题主/未 AC viewer 不返回算法标签名（防信息泄露），仅返回 `has_hidden_algorithm_tags=true` 占位标志；列表接口只返回题目标签（列表页无门控成本）。
4. 洛谷式发现路径：`?tag=` 筛选与全局搜索对所有人可按算法标签名发现题目。
5. 存量分类数据不迁移：DROP 后 seed 重打样例题标签；单客户端同步升级。

**Non-Goals:**

- 不做标签多选筛选（`?tag=` 保持单选）、不做标签 slug/颜色/描述、不做标签关注/订阅/编辑历史。
- 不在列表页做算法标签逐行门控展示（列表只显题目标签）。
- 不改评测引擎（noj-judge）、不改题目支持包协议。
- 不保留 `/api/v1/categories` 兼容别名（硬删除）。
- 不做算法标签的"用户自定义可见性"等个性化设置。

## Decisions

### D1. 数据模型：扁平 tags + kind 字段

`tags(id TEXT PK, name TEXT UNIQUE, kind TEXT CHECK in ('problem','algorithm'), created_at TEXT, updated_at TEXT)` + `problem_tags(problem_id FK CASCADE, tag_id FK CASCADE, PK(problem_id, tag_id))`。

- **为什么不用树**：算法/主题标签天然扁平，洛谷/HydroOJ 亦然；分类树的 parent_id/level 复杂度（循环引用检查、level 重算）随分类退役一并删除。
- **name 全局唯一（跨 kind）**：避免「图论」同时作为题目标签和算法标签造成筛选/搜索歧义；冲突返回 409 `ConflictError`（镜像 slug 冲突先例）。
- **不设 slug**：分类 slug 的用途（URL/机器可读标识）由 tag UUID 承担；无 SEO 需求。
- **保留 updated_at**：与 categories/problems 等表惯例一致；`tags.update` 审计受 90 天保留期限制，updated_at 保证「何时改的」长期可查（评审中对最初「不含」决定的修正）。
- **备选方案（否决）**：tags 单表 + `is_algorithm` boolean —— kind 枚举更易扩展（未来可能有第三类），语义显式。

### D2. 关联语义：沿用 `category_ids` 的全量替换模式

题目创建/更新载荷 `tag_ids: string[]`，`syncProblemTags` 先校验全部 tag 存在（不存在 → 400），再 delete+insert 全量替换（单事务）。与现行 `syncProblemCategories` 同构，权限沿用 `problem:create`/`write_own`/`write_any` 既有断言路径。

- **为什么沿用全量替换**：与既有模式一致，减少认知负担；打标签粒度到「题目编辑」已够用。
- **客观题限制**：`is_objective=true` 的题目校验 `tag_ids` 仅允许 kind='problem'（否则 400）——客观题系统无「通过」概念，禁止算法标签从根上消除门控歧义（见 D3）。
- **备选方案（否决）**：独立 `PUT /problems/:id/tags` 增量接口——引入第二套同步路径，无必要。

### D3. 可视性门控：后端过滤 + 占位标志（spoiler 模型）

详情接口（`optionalAuthMiddleware` 注入 viewer）计算 `visible = kind='problem' 全部 ∪ (viewer ∈ {admin, owner} ? 全部 : viewer 有 Accepted ? 全部 : ∅)`，响应：

```json
{
  "tags": [{ "id": "...", "name": "图论", "kind": "algorithm" }],
  "has_hidden_algorithm_tags": true
}
```

- **后端强制而非前端隐藏**：标签名是敏感信息（spoiler），必须服务端裁剪；`has_hidden_algorithm_tags` 只暴露布尔，不泄露名称与数量。
- **每请求现算、无缓存**：rejudge 后 AC 消失 → 标签立即隐藏，语义正确且无失效窗口。
- **列表接口只 JOIN kind='problem'**：列表/卡片无门控成本（无逐行 viewer 判定），且用户已确认列表只显题目标签。
- **AC 判定**：`EXISTS (SELECT 1 FROM submissions s JOIN evaluation_results er ON er.submission_id = s.id WHERE s.problem_id = ? AND s.user_id = ? AND er.status = 'Accepted')`。
- **客观题**：`is_objective=true` 的题目不允许关联算法标签（打标校验 400），门控不存在客观题分支——客观题系统无「通过」概念（无及格线字段），禁止优于发明新语义。
- **发现路径（有意泄露）**：`?tag=` 与搜索按算法标签名可发现题目隶属关系——用户明确选择洛谷式 tradeoff（详情页保护"做题前被剧透"，题库发现不受阻）。
- **备选方案（否决）**：严格隐藏（筛选/搜索也排除算法标签）——算法标签沦为纯 AC 后提示，失去发现价值。

### D4. 标签 API 与权限

`/api/v1/tags`（GET 公开，返回全量含 kind 与 `problem_count`（关联题目数，供管理页表格展示），按 name 升序）；`POST/PUT/DELETE /tags[/:id]` 与 `POST /tags/:id/merge` 走 `requirePermission("tag:manage")`（**RBAC 判定，不硬编码 adminMiddleware**）。RBAC seed 以 `tag:read`/`tag:manage` 替换 `category:*`（迁移 SQL 清理旧权限行）。`tag:read` 与旧 `category:read` 同现状——预置但当前无消费端点（`GET /tags` 公开），保留供未来按站点策略收口。

- **merge 语义**：事务内先删除与 target 冲突的重复关联，再将剩余 `problem_tags` 关联 source→target 重指向 → 删除 source → 审计 `tags.merge`；source==target → 400。
- **delete 语义**：DB 级联清 `problem_tags`，题目本身不受影响；审计 `tags.delete`。
- **新建标签默认仅 admin（可配置）**：`tag:manage` 默认不授予任何角色（仅 admin 隐式全权限），但保留在预置权限目录中，运营者可经角色管理授予自定义角色——满足「默认收口、按需放开」的管控诉求。普通用户（含 U 型 owner）只能从已有标签中选择；编辑器「新建」按钮仅对拥有 `tag:manage` 的用户可见。
- **备选方案（否决）**：U owner 随手新建（社区生长）——用户在讨论中明确选择 admin 管控；硬编码 `adminMiddleware`——不可配置，违背「权限系统化」诉求。

### D5. 筛选与搜索集成

- 列表：`?tag=<tag_id>` 沿用分类两段式（先查 `problem_tags` 拿 problem_id → `inArray`），与 `difficulty/keyword/type/number/owner_id` AND 叠加；单选（YAGNI）。
- 搜索：`searchProblems` 列表与 count 两处 WHERE 追加 `OR EXISTS (SELECT 1 FROM problem_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.problem_id = p.id AND t.name ILIKE ${likeQ} ESCAPE '\\')`，沿用 `escapeLikePattern` 防注入；响应结构不变（只做匹配，不返回标签）。
- **为什么 EXISTS 而非 join**：题目行唯一性不变（无重复行），无需 DISTINCT；ILIKE 与现有 trigram 兜底策略一致。

### D6. 退役策略：硬删除 + 不迁移

新迁移：`DROP TABLE problems_categories; DROP TABLE categories;` + 建新表 + `DELETE FROM permissions/role_permissions WHERE resource='category'`。`seedCategories()` → `seedTags()`（幂等固定 id；种子集：题目标签 `tag-lmcc`（LMCC 样例题）/`tag-beginner`（入门）；算法标签 `tag-simulate`（模拟）/`tag-sliding-window`（滑动窗口）/`tag-prefix-sum`（前缀和）/`tag-graph`（图论）/`tag-dp`（DP）/`tag-ds`（数据结构）/`tag-tree`（树））。样例 `problem.json` 的 `categories` → `tags`（按 name 解析），标注：1001 → [LMCC 样例题] + 算法[模拟]；1002 → [LMCC 样例题] + 算法[滑动窗口, 模拟]；1003 → [入门, LMCC 样例题] + 算法[模拟]。

- **为什么硬删除**：消费方仅本项目两个模块；分类树迁移到扁平标签无保真映射（层级信息必然丢失），「删掉重打」更干净且数据量极小（4 个种子分类）。
- **风险确认**：正式比赛题目若曾在生产打过分理会丢失关联——当前生产数据规模下可接受（维护者确认）。

### D7. 前端形态

- 列表：表格「分类」列 → 「标签」列（题目标签 chips，无标签显示 `--`）；`ProblemFilterBar` 分类 USelect → 标签 USelect（`GET /tags` 数据按 kind 分组，单选）。
- 详情页：题目标签 chips（可点击 → `/problems?tag=...`）；`has_hidden_algorithm_tags` 时渲染「🔒 算法标签 · 通过后显示」占位；AC 后展示算法标签 chips。
- 编辑器：分类 checkbox 组 → 标签多选（搜索已有；`tag_ids` 提交；「新建标签」仅 admin，调 `POST /tags` 后加入选择）。
- 管理页：`/admin/categories` 删除，新建 `/admin/tags`（名称/kind/题目数表格 + 创建/重命名/改 kind/合并/删除；删除用 `useDialog` danger 确认）；侧边栏菜单「分类管理」→「标签管理」。
- 审计页映射：`categories.delete` → `tags.create/update/delete/merge`。

## Risks / Trade-offs

- [筛选/搜索暴露算法标签隶属关系（spoiler 削弱）] → 用户明确接受洛谷式 tradeoff；详情页仍保护做题前剧透（主要 spoiler 载体）。
- [删除 categories 表破坏历史数据] → 维护者确认不迁移；迁移 SQL 与 seed 重打在同一变更内完成，dev/E2E 环境无遗留。
- [门控逻辑每请求一次 EXISTS 查询] → 单条详情页仅 1 次额外查询，可接受；列表页无此成本（只返回题目标签）。若未来热点，可加 `(problem_id, user_id)` 索引（submissions 已有 `(user_id, created_at)` 复合索引，实现时以 EXPLAIN 为准）。
- [客观题无「通过」概念，算法标签门控无法定义] → 已决议：客观题禁止关联算法标签（`syncProblemTags` 校验 400），从根上消除歧义；打标校验与门控规则均有对应测试。
- [name 全局唯一导致「模拟」被占用后无法再建同名不同 kind 标签] → 符合「标签名即语义」的产品直觉；重名诉求通过改名/合并解决。
- [kind 变更（改 kind / 跨 kind 合并）改变既有关联的可见性语义] → 由 admin 操作触发、有意为之（如算法标签并入题目标签后变人人可见）；spec 已明确「保留 target kind，语义以 target 为准」，并在合并审计中留痕。
- [并发：合并与打标签并发] → 依赖 PK 约束 + 事务 + CASCADE，无需额外锁；合并事务原子性保证无悬挂关联。
- [破坏性 API 变更影响 noj-tests E2E] → 同一 PR 内更新 E2E；CI 全绿为合入门槛。

## Migration Plan

1. 单次 Drizzle 迁移完成 DROP + CREATE + 权限清理（迁移不可回滚——符合本项目"迁移只追加"约束；回滚策略为整体代码回滚 + DB 备份恢复，本变更数据量小）。
2. `dev-setup` 幂等重跑：`seedTags()` 建种子标签，`problems:import` 按新 manifest `tags` 字段重打样例标签。
3. 部署顺序：core（含迁移）→ ui → noj-tests 验证；无分阶段兼容窗口（单客户端）。
4. OpenSpec：归档时 `category-management`/`admin-category-management` spec 移除，新增 `problem-tags`/`admin-tag-management` spec。

## Open Questions

无——原三项已全部确认：① 客观题禁止算法标签（打标校验 400）；② 样例标签集按题面精细标注（见 D6）；③ `tags` 增加 `updated_at`（见 D1）。
