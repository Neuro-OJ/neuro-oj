## ADDED Requirements

### Requirement: submissions.contest_id 列

`submissions` 表 SHALL 新增 `contest_id TEXT REFERENCES contests(id) ON DELETE SET NULL` 列。

- NULL = 非竞赛提交（默认值，向前兼容）
- 非 NULL = 竞赛内提交，指向对应竞赛
- 竞赛删除时 SHALL SET NULL（保留提交记录）

#### Scenario: 竞赛提交写入 contest_id

- **WHEN** 用户通过 `POST /api/v1/contests/:id/submit` 创建竞赛提交
- **THEN** `submissions` 表中该记录的 `contest_id` 被设置为对应竞赛 ID

#### Scenario: 普通提交 contest_id 为 NULL

- **WHEN** 用户通过 `POST /api/v1/submissions` 创建普通提交
- **THEN** `submissions` 表中该记录的 `contest_id` 为 NULL

#### Scenario: 删除竞赛不删除提交

- **WHEN** 管理员删除一个竞赛，该竞赛有 100 条关联提交
- **THEN** 这 100 条 submissions 的 `contest_id` 被 SET NULL，提交记录自身保留

### Requirement: 竞赛相关索引

系统 SHALL 为竞赛查询性能创建以下索引：

- `idx_submissions_contest_id` — 单列索引，优化按竞赛筛选提交
- `idx_submissions_contest_problem_user` — 复合索引 `(contest_id, problem_id, user_id, created_at)`，优化竞赛排名查询
- `idx_contests_created_by` — 优化管理员查询自己创建的竞赛
- `idx_contests_start_time` / `idx_contests_end_time` — 优化按时间筛选竞赛列表
- `idx_contest_participants_user` — 优化查询用户参与的所有竞赛

#### Scenario: 竞赛排名查询使用复合索引

- **WHEN** 系统执行 ICPC 排名 SQL（按 contest_id 筛选 + problem_id/user_id 分组 + created_at 排序）
- **THEN** PostgreSQL 查询计划使用 `idx_submissions_contest_problem_user` 索引
