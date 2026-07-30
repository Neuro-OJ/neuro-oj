## MODIFIED Requirements

### Requirement: 全站用户榜单查询

系统 SHALL 提供 `GET /api/v1/rankings` 公开接口，按解题数降序返回全站用户榜单。

榜单条目 SHALL 包含：`rank`（名次，1-based 整数）、`user_id`、`username`、`solved_count`（独立通过的题目数）、`total_submissions`（总提交数）、`acceptance_rate`（0–1 浮点数）。

榜单 SHALL 排除 root 系统用户（`users.id = '0'`），且 SHALL 仅展示至少通过一道题的用户。

竞赛提交是否计入统计 SHALL 由 `contests.affect_global_ranking` 字段控制：
- `affect_global_ranking = true` 的竞赛提交计入全局 `solved_count`
- `affect_global_ranking = false` 的竞赛提交不计入全局 `solved_count`
- 所有非竞赛提交（`contest_id IS NULL`）始终计入

排序键 SHALL 为：`(solved_count DESC, acceptance_rate DESC, total_submissions ASC, users.created_at ASC)`，确保相同指标下排名稳定。

#### Scenario: 正常查询全站榜单（含计入统计的竞赛提交）

- **WHEN** 用户 A 有 3 道普通 AC + 1 道 `affect_global_ranking=true` 的竞赛 AC（共 4 道）
- **THEN** A 的 `solved_count` 为 4

#### Scenario: 不计入全局排名的竞赛提交

- **WHEN** 用户 B 有 2 道普通 AC + 2 道 `affect_global_ranking=false` 的竞赛 AC
- **THEN** B 的 `solved_count` 为 2（竞赛 AC 不计入）

#### Scenario: 排序稳定

- **WHEN** 两个用户 D（solved=3, rate=0.7, total=4）和 E（solved=3, rate=0.6, total=5）通过题数相同
- **THEN** D.rank < E.rank（因为 D.acceptance_rate 更高）

#### Scenario: 排除 root 用户

- **WHEN** root 系统用户（id='0'）存在且有提交记录
- **THEN** `GET /api/v1/rankings` 返回结果中不包含 root 用户的条目

#### Scenario: 全站无用户通过任何题

- **WHEN** 系统中所有用户都没有 `evaluation_results.status = 'Accepted'` 的记录
- **THEN** `GET /api/v1/rankings` 返回 `{ data: [], pagination: { page: 1, per_page: 50, total: 0, total_pages: 0 } }`，HTTP 200

#### Scenario: 公开访问无需 token

- **WHEN** 任意访问者（含未登录用户）发送 `GET /api/v1/rankings`
- **THEN** 系统正常返回榜单，无需 Authorization 头

## ADDED Requirements

### Requirement: 竞赛维度排名过滤

全局排名计算 SHALL 在统计 `solved_count` 时过滤掉 `affect_global_ranking = false` 的竞赛提交。过滤逻辑 SHALL 在 SQL 查询层实现，通过 LEFT JOIN `contests` 表并检查 `affect_global_ranking` 条件。

#### Scenario: 混合提交的准确统计

- **WHEN** 用户 C 有普通 AC（3 题）+ 竞赛 A AC（2 题，affect_global_ranking=true）+ 竞赛 B AC（1 题，affect_global_ranking=false）
- **THEN** C 的 `solved_count` = 3 + 2 = 5（竞赛 B 不计入）
