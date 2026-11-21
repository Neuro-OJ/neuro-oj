# 题目标签系统：category 退役，双类标签（题目标签 + 算法标签）设计

- 日期：2026-08-14
- 关联 issue：[#223 feat: 支持题目标签系统](https://github.com/Neuro-OJ/neuro-oj/issues/223)
- OpenSpec 变更：`openspec/changes/problem-tags-replace-categories/`

## Context

NOJ 原有题目组织维度为 admin 管控的分类树（`categories`：parent_id 自引用 + level 缓存；`problems_categories` 多对多）。issue #223 原案为「标签与分类树互补」，经讨论升级定位：**分类系统整体退役，由双类标签系统取代**，并引入洛谷式 spoiler 模型——算法标签只有通过题目（Accepted）后才在详情页展示。

## 决策摘要

| # | 决策 | 结论 |
|---|---|---|
| D1 | 数据模型 | `tags(id, name 全局唯一, kind ∈ {problem, algorithm}, created_at, updated_at)` + `problem_tags(problem_id, tag_id)` 复合 PK 双 CASCADE；无 slug/树/颜色 |
| D2 | 关联语义 | 题目载荷 `tag_ids` 全量替换（沿用 `category_ids` 模式）；**客观题禁止算法标签**（400，客观题无「通过」概念） |
| D3 | spoiler 门控 | 后端强制：详情接口对非 admin/题主/无 Accepted 的 viewer 裁剪算法标签，仅返回 `has_hidden_algorithm_tags=true` 占位布尔；列表接口只返回题目标签；每请求实时计算 |
| D4 | 权限 | 标签写接口走 `requirePermission("tag:manage")` RBAC 判定（**不硬编码 admin**）：默认不授予任何角色（仅 admin 隐式），运营者可经角色管理授予自定义角色；打标签沿用 `problem:write_own/write_any` |
| D5 | 筛选/搜索 | `?tag=<id>` 单选 AND 叠加；全局搜索标签名 EXISTS+ILIKE（两种 kind，洛谷式发现路径，接受反向暴露 tradeoff） |
| D6 | 退役策略 | 硬删除分类表/接口/页面，**存量数据不迁移**；种子标签重打样例题 |
| D7 | 前端 | 列表只显题目标签；详情页占位「🔒 算法标签 · 通过后显示」；编辑器多选（新建按钮仅 `tag:manage` 可见）；`/admin/tags` 管理页（CRUD+合并）取代 `/admin/categories` |

## 关键实现要点


- 门控实现：`applyAlgorithmTagVisibility(problem, viewer)` 在 `problems-list.ts`，路由 `GET /problems/:id` 以 `optionalAuthMiddleware` + `resolvePermissions` 判定 admin，AC 判定为 `EXISTS(submissions ⋈ evaluation_results.status='Accepted')`。
- 合并语义：单事务内「删冲突关联 → 剩余重指向 target → 删 source」，保留 target 的 name/kind（跨 kind 合并的可见性语义变化由 admin 承担，审计留痕）。
- 审计四动作：`tags.create {name,kind}` / `tags.update {from,to}`（`"name (kind)"` 格式串）/ `tags.delete {name,kind}` / `tags.merge {source_name,target_name}`。

## 风险与取舍

- **筛选/搜索暴露算法标签隶属**：洛谷式发现路径的有意取舍，详情页仍保护做题前剧透。
- **`tags.update` 审计 90 天清理后历史丢失**：以 `updated_at` 字段兜底长期可查。
- **客观题门控歧义**：从根上禁止（打标校验），优于发明「满分=通过」新语义。
- **E2E 门控 AC 场景依赖 judge 可用**：`isJudgeAvailable()` 不可用时优雅跳过，CI 全栈跑全量。

## Open Questions

无（原三项已确认：客观题禁止算法标签、样例标签集按题面精细标注、tags 增加 updated_at）。
