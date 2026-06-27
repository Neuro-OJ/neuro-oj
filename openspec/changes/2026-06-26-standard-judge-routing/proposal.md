## Why

当前 Neuro OJ 的 `problems` 表无法区分标准题（stdout diff）与 SPJ（自定义 `evaluate.py`）。
所有题目都通过 `python3 /tmp/evaluate.py` 评测，标准题白白多 ~100ms Python 启动开销，
且评测流程与 Python 脚本强耦合，无法优化最常见（标准 A+B 类）的评测路径。

需要引入题目级别的评测类型字段，让 noj-judge 区分执行路径：
标准题由 Rust 原生执行器直接评分，SPJ 题保留现有 `evaluate.py` 流程。

## What Changes

- **数据库层**：problems 表新增 `judge_type` 字段（值 `standard` / `special`，默认 `special`），CHECK 约束限制取值，0006 迁移将样例题 1003 标记为 `standard`
- **API 层**：`POST /api/v1/problems` / `PUT /api/v1/problems/:id` 接收 `judge_type`；`GET /api/v1/problems?judge_type=...` 支持筛选；列表与详情响应包含 `judge_type`
- **MQ 消息**：JudgeTask 增加 `judge_type` 字段，从 problem 记录透传到 noj-judge
- **Worker 层**：noj-judge 按 `judge_type` 分流执行
  - `standard`：原生 Rust 执行器（新建 `judge/standard.rs`），解压支持包后读 `visible.jsonl` / `hidden.jsonl`，逐 case 跑用户代码做 stdout diff，复刻 problem 1003 的评分算法
  - `special`：保留现有 `python3 /tmp/evaluate.py` 路径
- **前端**：管理后台题目表单新增判题类型下拉；题目列表与详情页对 SPJ 题目显示橙色徽章
- **滚动部署**：noj-judge 必须先于 noj-core 升级（避免新 noj-core 发送的 `judge_type` 字段被旧 worker 静默忽略导致标准题走错路径）

## Capabilities

### Modified Capabilities

- `database-schema`：problems 表新增 `judge_type` 列（text NOT NULL DEFAULT 'special'，CHECK IN ('standard','special')），迁移 0006 将 problem 1003 标记为 standard
- `problem-management`：题目 CRUD API 接收/返回 `judge_type`，列表筛选支持 `judge_type`，非法值返回 400；JudgeTask 消息透传 `judge_type`
- `admin-problem-management`：管理后台创建/编辑表单新增判题类型下拉（标准题 / SPJ 题）

## Impact

- **noj-core**：drizzle schema 加列、0006 迁移、`types/problems.ts` / `types/index.ts` 类型扩展、`services/problems.ts` 与 `services/submissions.ts` 透传字段
- **noj-judge**：`types.rs` 新增 `JudgeType` 枚举与 serde 默认值；`judge/runner.rs` 重构（抽取共享 prepare 函数 + match 分流）；新建 `judge/standard.rs`（原生评分执行器）
- **noj-ui**：`components/ProblemEditor.vue` 加下拉并透传字段；`pages/problems.vue` 表格新增判题列；`pages/problems/[id].vue` 详情页加 SPJ 徽章
- **OpenSpec**：database-schema、problem-management、admin-problem-management 三个 spec delta
- **数据库**：执行 migration 0006 加列加约束；现有样例题 1003 改判题类型为 standard

## Out of Scope

- 不修改其它评测状态机（如 TLE / OOM 的检测逻辑）
- 不改动 JudgeResult / submission 持久化格式
- 不支持编译型语言（C/C++/Rust）走 standard 路径——当前实现仅针对 Python3 用户代码
- 不引入对标准题的自定义评分脚本——所有标准题统一使用 problem 1003 的"内容分 8 + 格式分 2"算法