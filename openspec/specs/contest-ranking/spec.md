## Purpose

定义竞赛排名计算规范，支持 ICPC（罚时排名）、IOI/OI（总分排名）三种赛制，以及排名公开规则和封榜功能。

## Requirements

### Requirement: ICPC 罚时排名

系统 SHALL 为 ICPC 类型竞赛提供罚时制排名计算。

排名计算规则：
- 每人每题只取**首次 AC** 的提交
- 罚时 = Σ(AC 时间距比赛开始的分钟数 + 20 × AC 之前的失败尝试次数)
- 未解题不计罚时
- 排序规则：`solved_count DESC, total_penalty ASC, last_ac_time ASC`
- 前三字段均相同时，按 `registered_at ASC, user_id ASC` 产生稳定名次

排名响应 SHALL 包含：
- `rank` — 名次（1-based）
- `user_id`、`username`
- `solved` — 解题数
- `penalty` — 总罚时（分钟，整数）
- `problem_details` — 每题详情：`{label, solved, attempts, solve_time_minutes?}`

`GET /api/v1/contests/:id/ranking` SHALL 接受 `type` 参数区分排名模式。

#### Scenario: 单人单题 AC 排名
- **WHEN** ICPC 竞赛中用户 A 在比赛开始 10 分钟后 AC 了题目 A（首次即 AC）
- **THEN** A 的排名为第 1，solved=1，penalty=10

#### Scenario: 多人多题罚时排名
- **WHEN** ICPC 竞赛中用户 A AC 2 题（罚时 10+30=40），用户 B AC 2 题（罚时 15+25=40），但 B 的最后 AC 时间更早
- **THEN** B.rank=1, A.rank=2（同分同罚时，last_ac 更早者优先）

#### Scenario: 失败尝试计入罚时
- **WHEN** ICPC 竞赛中用户 A 对题目 A 在第 5 分钟 WA 一次，第 15 分钟 AC；对题目 B 在第 20 分钟 AC
- **THEN** penalty = (15 + 20×1) + (20 + 20×0) = 35 + 20 = 55

#### Scenario: AC 之后的失败提交不计罚时
- **WHEN** ICPC 竞赛中用户 A 在第 10 分钟 AC 了题目 A，之后在第 50 分钟又提交了题目 A（WA）
- **THEN** A 的 penalty 仅计算 AC 的部分（10 分钟），第 50 分钟的 WA 不影响排名

#### Scenario: ICPC 成绩完全相同时按报名时间排序
- **WHEN** 两名参赛者的解题数、总罚时和最后通过时间相同，但报名时间不同
- **THEN** 报名更早的参赛者排名更靠前

#### Scenario: ICPC 成绩与报名时间相同时按用户 ID 排序
- **WHEN** 两名参赛者的解题数、总罚时、最后通过时间和报名时间均相同
- **THEN** 用户 ID 按升序较小的参赛者排名更靠前

### Requirement: IOI/OI 总分排名

系统 SHALL 为 IOI 和 OI 类型竞赛提供总分制排名计算。

排名计算规则：
- 每题取最高分提交（同分取最早）
- 总分 = Σ(每题最高分)
- 总耗时 = Σ(计入排名提交的 created_at - contest.start_time)
- 排序规则：`total_score DESC, total_time ASC`

排名响应 SHALL 包含：
- `rank` — 名次
- `user_id`、`username`
- `total_score` — 总分（×100 整数）
- `total_time_seconds` — 总耗时（秒）
- `problem_scores` — 每题详情：`{label, best_score, attempts}`

#### Scenario: IOI 每题取最高分
- **WHEN** IOI 竞赛中用户 A 对题目 A 提交 3 次，分数分别为 5000、8000、6000
- **THEN** A 的题目 A 得分为 8000（取最高分）

#### Scenario: IOI 同分同分取最早
- **WHEN** IOI 竞赛中用户 A 对题目 A 在第 10 分钟拿 10000 分，第 30 分钟也拿 10000 分
- **THEN** 计入排名的是第 10 分钟的提交（同分取最早）

#### Scenario: 无有效提交的用户排名
- **WHEN** IOI 竞赛中用户 A 注册参赛但未提交任何代码
- **THEN** A 的 total_score=0，排在所有有分数用户之后

### Requirement: 竞赛排名公开规则

`GET /api/v1/contests/:id/ranking` SHALL 按竞赛类型控制排名可见性：

- ICPC/IOI：排名实时公开，无需登录
- OI：竞赛 running 期间仅返回参赛者自己的排名行（需登录）；竞赛 ended 后全量公开
- 封榜期间（仅 ICPC）：公开排名冻结至 `config.freeze_time` 时点的状态；管理员始终可见完整排名
- 封榜在 `end_time` 后**自动解封**（由 `config.unfreeze_after_end` 控制，默认 true）

#### Scenario: OI 竞赛期间隐藏他人排名
- **WHEN** OI 竞赛 running 期间参赛者 A GET `/api/v1/contests/<id>/ranking`
- **THEN** 系统仅返回 A 自己的排名行，不包含其他参赛者

#### Scenario: OI 竞赛结束后公开排名
- **WHEN** OI 竞赛 ended 后任意访问者 GET `/api/v1/contests/<id>/ranking`
- **THEN** 系统返回完整排名

#### Scenario: ICPC 封榜期间管理员可见完整排名
- **WHEN** ICPC 竞赛已过 config.freeze_time，管理员 GET `/api/v1/contests/<id>/ranking?admin=true`
- **THEN** 系统返回基于全部提交计算的完整排名

#### Scenario: ICPC 封榜在竞赛结束后自动解封
- **WHEN** ICPC 竞赛 end_time 已过
- **THEN** 公开排名恢复完整数据，所有访问者可见最终排名
