## Why

2026 LMCC 成人组第一轮为全国统一命题机试，题型为客观题（考核大模型基本素养与概念类知识），Neuro OJ 需要新增客观题（单选/多选/判断）题型以支持该场景。对标 HydroOJ 已有 objective 题型（服务端直接判定，不走评测容器），NOJ 需要同等的客观题能力。

## What Changes

- 新增客观题卷（套卷）形态：套卷复用 `problems` 表（`type` 扩展为 'O'），`title` / `description` / `owner_id` / `number` / `display_id`（如 `O1001`）/ 搜索 / 列表 / 权限全部复用现有机制
- 新增 `objective_questions` 表：小题（单选/多选/判断）必须通过外键绑定套卷，不可孤立存在；选项与答案存 JSONB
- 新增 `objective_submissions` 表：客观题提交记录（答案、得分、逐题判定详情），复用竞赛关联能力（`contest_id`）
- 服务端即时判定：提交不走评测队列（noj-judge 无改动），noj-core 直接比对答案写入 `objective_submissions`
- 判分规则：每道小题全对才得分（含多选），卷面分 = 答对数/总数 × 100（×100 整数存储）
- 两种提交模式：练习模式（可重复提交，成绩取最高分）；竞赛模式（校验竞赛进行中 + 已报名 + 该卷在竞赛题单，只允许提交一次）
- 竞赛集成：套卷可挂入竞赛（`contest_problems` 天然支持），竞赛排名计入客观题提交
- UI：套卷列表/详情（答题 + 即时判定显示）/编辑（小题编辑器）；竞赛题目页按 type='O' 渲染客观题表单
- 答案可见性：非 owner 的公开视图裁剪答案与解析字段；判定详情仅提交者本人/admin 可见

## Capabilities

### New Capabilities

- `objective-questions`: 客观题卷与小题的管理（套卷 CRUD、小题 CRUD、排序、答案可见性裁剪）
- `objective-judging`: 客观题提交与即时判定（判分规则、练习/竞赛两种模式、提交历史与最高分）

### Modified Capabilities

- `problem-management`: problems 表 type 约束扩展 'O'，客观题卷创建无需 `runtime_config`
- `problem-ownership`: O 型套卷的所有权规则（owner/admin CRUD，同 U 型规则）与 display_id 双索引解析
- `database-schema`: 新增 `objective_questions` / `objective_submissions` 表；`problems` 表 CHECK 约束与 `runtime_config` 可空变更
- `contest-participation`: 竞赛中客观题卷的提交规则（一次性提交、时间窗与参赛资格校验）
- `contest-ranking`: 竞赛排名纳入客观题提交（满分映射 Accepted / 非满分 WrongAnswer）

## Impact

- **noj-core**（主要改动）：
  - `src/db/schema.ts` + Drizzle 迁移（新表、约束变更）
  - `src/types/objective.ts`（新增 DTO）、`src/services/objective-*.ts`（新增判定/小题/提交服务）
  - `src/services/problems-crud.ts` / `problems-list.ts` / `src/routes/problems.ts`（type='O' 适配）
  - `src/services/contest-ranking.ts`（UNION 客观题提交）
  - `src/routes/objective.ts`（新增路由）+ `src/app.ts` 注册
- **noj-ui**：新增 `/objective-papers` 系列页面（列表/新建/编辑/详情答题）、竞赛题目页客观题表单、Navbar 入口
- **noj-tests**：新增客观题 E2E（建卷 → 建小题 → 提交 → 即时判定落库；竞赛集成）
- **noj-judge**：无改动
