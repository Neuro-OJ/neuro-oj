## Context

NOJ 当前已有分类树（admin 管控）、标签系统、竞赛系统和客观题系统，但缺少用户可自主组织的学习路径载体。Issue #224 要求对标 HydroOJ `training` / 洛谷题单，实现用户可创建的扁平题单。设计文档见 `docs/superpowers/specs/2026-08-17-training-design.md`，实施计划见 `docs/superpowers/plans/2026-08-17-training.md`。

本变更新增一个独立 training 模块，不修改竞赛/标签/分类的既有语义。

## Goals / Non-Goals

**Goals:**

- 提供 `trainings` + `training_problems` 两张表，支持题单 CRUD 与题目有序收录。
- 提供三态可见性：`private` / `unlisted` / `public`。
- 提供 RBAC 细粒度权限 `training:*`，`publish` / `pin` 默认仅管理员。
- 提供 AC 进度聚合：编程题 Accepted、客观题满分视为通过。
- 提供前端题单列表、我的题单、详情、后台管理页面，并在用户主页/题目页加入入口。

**Non-Goals:**

- 不实现 DAG 章节、前置依赖、训练计划进度解锁。
- 不实现公开审核流（用户申请公开 → 管理员审批）。
- 不实现题单收藏、订阅、推荐等社交功能。
- 不修改现有竞赛、标签、分类模块。

## Decisions

### 1. 独立 training 模块，而非泛化 contest_problems

- **选择**：新增独立 `trainings` / `training_problems` 表与独立 service/route。
- **理由**：竞赛题目有 `label` / `score` 等特有字段，泛化集合表会引入兼容负担；独立模块边界清晰，后续可平滑扩展章节/前置依赖。
- **备选**：泛化 `collection_problems`、扩展 categories/tags；均因语义不匹配被否决。

### 2. 三态可见性与 RBAC

- `private` 仅创建者（或 `training:read_any`）可见；`unlisted` 知道 URL 即可访问但不出现在列表；`public` 仅具备 `training:publish` 的管理员可设置。
- `is_pinned` 仅具备 `training:pin` 的管理员可设置。
- 默认 user 角色获得 `training:create/read/write_own/delete_own`，`publish/pin` 不授予普通用户。

### 3. 题目收录不做类型过滤

- 题单可收录 U/P/客观题任意类型。
- U 型题维持“unlisted”语义：不出现在官方题目目录，但可通过 URL 或题单跳转打开。
- 因此题单详情直接返回收录题目，不额外按访问者过滤。

### 4. 进度由现有提交记录派生

- 不新增进度表。
- 编程题：`submissions` join `evaluation_results` 中 `status='Accepted'`。
- 客观题：`objective_submissions` 中 `score=10000`。
- 匿名请求不计算进度，返回 `accepted=false`。

### 5. 排序策略

- `position` 在同一题单内唯一。
- 加题到指定位置时，先对已有 `position >= target` 的行 +1，再插入；追加时取 `max(position)+1`。
- 批量重排采用“校验集合一致后 DELETE + INSERT”的原子事务，保证最终顺序。

### 6. 前端只读/编辑边界

- 前台详情页仅创建者本人显示管理控件。
- 管理员对他人题单的编辑只出现在 `/admin/trainings` 后台页，前台展示他人题单一律只读。

## Risks / Trade-offs

- [U 型题经 public 题单被枚举] → 接受：U 型题本身可通过 URL 访问，题单仅额外提供入口；与需求方确认“题单允许收录 U 题（无论题单可见性）”。
- [批量重排 DELETE+INSERT 产生短暂空窗] → 使用数据库事务包裹，外界不可见中间状态。
- [后台“查看全部题单”数据量增长] → 使用分页，后续可按需增加 visibility/created_by 筛选。
- [进度聚合随题单题目数增加有查询成本] → 按 `problem_id IN (...)` 批量查询，避免 N+1；后续可加缓存/物化。

## Migration Plan

1. `deno task db:generate` 生成 `trainings` / `training_problems` 迁移。
2. `deno task db:migrate` 应用迁移。
3. 发布后端 API 与 RBAC 种子（幂等）。
4. 发布前端页面。
5. 回滚策略：新表不影响现有功能；如需回滚，删除新迁移即可（未上线数据时）。

## Open Questions

- 后台是否需要在第一版支持按创建者/可见性筛选全量题单：当前计划实现 `listAllTrainings` 全量分页，筛选可作为后续增强。
