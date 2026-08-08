## Context

Neuro OJ 目前仅支持编程题（U 用户题 / P 主题题），评测依赖 noj-judge 双容器沙箱 + Redis MQ。2026 LMCC 成人组机试需要客观题（单选/多选/判断）题型，对标 HydroOJ 的 objective 题型（服务端直接判定，不走评测容器）。

关键现状约束：
- `problems.type` 有 CHECK 约束 `('U','P')`；`runtime_config` NOT NULL（双容器评测配置）
- `submissions.code` / `language` NOT NULL，`problem_id` FK → problems.id（为编程提交设计）
- 竞赛通过 `contest_problems` 关联题目（FK → problems.id），排名由 `contest-ranking.ts` 基于 submissions + evaluation_results 计算
- display_id 双索引解析（`^([UuPp])(\d+)$`）、搜索（tsvector 生成列）、列表筛选均按 type 工作

## Goals / Non-Goals

**Goals:**
- 新增客观题卷（套卷）实体：可创建/编辑/删除/列表，小题必须绑定套卷
- 支持单选/多选/判断三种小题形态，选项与答案服务端存储
- 提交即时判定落库（不走评测队列），练习模式可重复提交取最高分
- 竞赛集成：套卷可挂入竞赛，竞赛内只允许一次提交，排名计入
- 答案不可泄露：非 owner 视图裁剪答案/解析，判定详情仅提交者/admin 可见

**Non-Goals:**
- 不涉及 noj-judge / 评测引擎任何改动
- 不做多选部分给分（全对才得分）
- 不做客观题进入全局搜索词条之外的特殊处理（搜索沿用现有 tsvector 机制）
- 不做考试倒计时/强制交卷等"监考"能力（竞赛时间窗已由竞赛系统提供）
- 不改动现有编程题的任何行为

## Decisions

### D1: 套卷复用 problems 表（type 扩展为 'O'），而非独立 objective_papers 表

套卷就是"一道题"的泛化：`title` / `description` / `owner_id` / `number` / `display_id`（`O1001`）/ 搜索 / 列表筛选 / 权限体系全部天然复用。需要两处放宽：
- `problems_type_check`：`('U','P')` → `('U','P','O')`
- `runtime_config`：NOT NULL → 可空（O 型无评测容器配置；U/P 行为不变）

**备选**：独立 `objective_papers` 表。被否决——display_id、提交历史、搜索、权限逻辑全部需要另写一套，且竞赛 `contest_problems` FK 无法复用。

### D2: 客观题提交使用新表 objective_submissions，而非复用 submissions

`submissions` 的 `code` / `language` NOT NULL、status 状态机（pending→judging→finished）、Redis MQ 流程均为编程题设计。客观题判定是同步的、无代码，硬塞会产生大量 NULL 与分支。新表按客观题语义建模：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| paper_id | TEXT FK → problems.id CASCADE | 套卷 |
| user_id | TEXT FK → users.id | 提交者 |
| contest_id | TEXT FK → contests.id SET NULL | 竞赛提交时非空 |
| submission_type | TEXT CHECK ('practice','contest') | 练习 / 竞赛 |
| answers | JSONB | `{question_id: ["A","C"]}` |
| score | INTEGER | 卷面分 ×100（与 evaluationResults.score 一致） |
| status | TEXT | `finished`（即时判定） |
| details | JSONB | 逐题对错 + 期望/给定答案 |
| created_at | TEXT | ISO 8601 |

**备选**：复用 submissions（code 改可空 + answers 列）。被否决——用户明确选择独立表，保持编程题提交表语义纯净，两套查询逻辑分开。

### D3: 判分规则 —— 全对才得分，服务端纯函数判定

- 单选/判断：给定答案与标准答案**集合精确相等**
- 多选：**完全匹配**（全对才得分，不做部分给分）
- 卷面分：`round(correct / total × 10000)`（×100 整数，与现有 score 约定一致）
- 判定逻辑抽成纯函数（`services/objective-judge.ts`），输入问题定义 + 用户答案，输出逐题结果与得分，便于单元测试

### D4: 练习 / 竞赛两种提交模式

- **练习**（`contest_id` 为空）：允许重复提交，每次落库；"最高分" = `MAX(score)` group by (user_id, paper_id)
- **竞赛**（`contest_id` 非空）：提交前校验——竞赛存在且 `running`、用户已注册、套卷属于该竞赛题单、该用户对该卷无既有提交（唯一索引或先查后插）；违规返回 4xx。提交后 `submission_type='contest'`

### D5: 竞赛集成 —— contest_problems 天然复用 + ranking UNION

- `contest_problems.problem_id` FK 已指向 problems.id，O 型套卷可直接挂入，无需改表
- `contest-ranking.ts` 的 `evaluated_submissions` CTE UNION ALL 客观题提交：满分卷 → `status='Accepted'`，非满分 → `'WrongAnswer'`，时间取提交时间；三种赛制（ICPC/IOI/OI）逻辑天然兼容

### D6: 答案可见性裁剪

- 套卷详情 / 小题列表 API 按请求者身份返回：owner/admin 含 `answer` / `explanation`；其他用户裁剪
- 提交判定的 `details`（含期望答案）仅提交者本人 / admin 可读
- 竞赛模式提交后不返回解析（防泄题），练习模式提交后返回逐题解析

### D7: API 组织 —— 独立 objective 路由 + 套卷走现有 problems 端点

- 套卷 CRUD：复用 `POST/GET/PUT/DELETE /api/v1/problems`（type='O'），display_id 正则扩展 `O`
- 小题与提交：新路由 `/api/v1/objective/...`（papers/:id/questions CRUD、papers/:id/submit、submissions 历史/详情/最高分）
- 竞赛内提交复用 submit 端点 + `contest_id` 参数（服务端按 D4 校验），避免重复端点

## Risks / Trade-offs

- [problems 表约束放宽影响编程题流程] → `runtime_config` 可空仅影响 O 型；U/P 创建路径继续强制校验（createProblem 中按 type 分支），编程题行为不变
- [ranking UNION 引入查询复杂度] → 客观题提交量远小于编程题；UNION ALL 仅增加一个子查询，竞赛规模下可接受；E2E 覆盖排名正确性
- [竞赛一次性提交存在并发双提交竞态] → 先查后插 + `objective_submissions(paper_id, user_id, contest_id)` 部分唯一索引兜底（23505 冲突转为 400）
- [非 owner 答案泄露（API 层疏漏）] → 裁剪逻辑集中在 objective 服务层单一出口（`serializePaper`），路由不直接回传原始行
- [旧数据兼容] → CHECK 约束放宽与列可空均为向后兼容变更，无需数据回填；迁移仅 DDL

## Migration Plan

1. `deno task db:generate` 生成迁移（DROP 旧 CHECK + ADD 新 CHECK；`ALTER COLUMN runtime_config DROP NOT NULL`；CREATE TABLE objective_questions / objective_submissions）
2. 迁移文件人工复核（不带 schema 前缀，遵循历史迁移陷阱教训）
3. `00_migrate_test.ts` 先行验证迁移可执行；部署时 `deno task db:migrate` 顺序执行
4. 回滚：本变更全部为增量（新表 + 约束放宽），无数据破坏；如需回滚仅撤销代码，保留表结构亦可

## Open Questions

无阻塞性问题。竞赛模式下"提交后是否允许查看自己答卷"默认不展示解析（防泄题），如需调整可在实现评审中提出。
