## Purpose

定义 Neuro OJ 类 Kaggle 赛制（`contests.type='kaggle'`）的分数制排名计算与提交次数限制规范。

## Requirements

### Requirement: 类 Kaggle 赛制排名

系统 SHALL 为 `contests.type='kaggle'` 的竞赛提供分数制排名计算。

排名规则：
- 每题取历史最高分提交（同分取最早）。
- 总分 = Σ(每题最高分)。
- 平局按“最后一次**严格刷新**最高分的提交时间”早者优先；同分提交不算刷新。
- 前三字段均相同时，按 `registered_at ASC, user_id ASC` 产生稳定名次。

排名响应 SHALL 包含：
- `rank` — 名次（1-based）
- `user_id`、`username`
- `total_score` — 总分（×100 整数）
- `last_submission_at` — 最后一次刷新最高分的提交时间
- `problem_scores` — 每题详情：`{label, best_score, attempts, last_best_at}`

#### Scenario: 每题取最高分

- **WHEN** 类 Kaggle 竞赛中用户 A 对题目 A 提交 3 次，分数分别为 5000、8000、6000
- **THEN** A 的题目 A 得分为 8000（取最高分）

#### Scenario: 同分取最早

- **WHEN** 用户 A 对题目 A 在第 10 分钟拿 10000 分，第 30 分钟也拿 10000 分
- **THEN** 计入排名的是第 10 分钟的提交（同分取最早）

#### Scenario: 总分求和与平局时间

- **WHEN** 用户 A 和 B 总分相同，A 最后一次刷新最高分的提交时间早于 B
- **THEN** A 排名在 B 之前

#### Scenario: 无有效提交的用户排名

- **WHEN** 用户 A 注册参赛但未提交任何代码
- **THEN** A 的 total_score=0，排在所有有分数用户之后

### Requirement: 比赛配置支持每道题提交次数限制

系统 SHALL 在 `contests.config` 中支持 `submission_limits` 配置，格式为 `{ "<problem_id>": <number> }`，表示该题在比赛内最多允许的提交次数。未配置的题目不限制提交次数。

提交次数 SHALL 统计该用户在该比赛内对该题的所有提交（含 `error` 提交）。

当某题达到提交次数上限后，系统 SHALL 拒绝该用户对该题的新提交，返回 HTTP 400。

#### Scenario: 配置单题提交上限

- **WHEN** 主办方创建比赛时设置 `config.submission_limits = { "<problem-id>": 15 }`
- **THEN** 用户对该题提交达到 15 次后，第 16 次提交被拒绝

#### Scenario: 未配置提交上限

- **WHEN** 比赛未配置某题的 `submission_limits`
- **THEN** 用户对该题提交次数不受限制

### Requirement: 实时榜与最终榜

系统 SHALL 为类 Kaggle 竞赛提供实时排行榜和最终排行榜。实时榜在比赛进行中可见，最终榜在比赛结束后按相同规则计算并固定。

#### Scenario: 比赛进行中查看实时榜

- **WHEN** 用户 GET `/api/v1/contests/:id/ranking`
- **THEN** 系统返回当前实时排名

#### Scenario: 比赛结束后查看最终榜

- **WHEN** 比赛已结束，用户 GET `/api/v1/contests/:id/ranking`
- **THEN** 系统返回最终排名，不再随新提交变化
