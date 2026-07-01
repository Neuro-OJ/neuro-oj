## ADDED Requirements

### Requirement: 用户主页响应包含 rank 字段

系统 SHALL 在 `GET /api/v1/users/:id/profile` 响应对象中追加 `rank` 字段，表示该用户在全站榜单的排名。

`rank` 字段类型 SHALL 为 `number | null`：用户至少有 1 道题通过时为名次（1-based 整数），未上榜时为 `null`。

`rank` 字段 SHALL 与现有 `stats.solved_count`、`stats.acceptance_rate` 等字段并列，且 SHALL NOT 破坏现有响应结构。

#### Scenario: 有通过记录的用户返回 rank

- **WHEN** 用户 A 通过了 5 道题，当前全站排名第 2
- **THEN** `GET /api/v1/users/A.id/profile` 响应对象包含 `rank: 2`，HTTP 200

#### Scenario: 无通过记录的用户返回 null

- **WHEN** 用户 B 没有任何通过的题目
- **THEN** `GET /api/v1/users/B.id/profile` 响应对象包含 `rank: null`，HTTP 200

#### Scenario: root 用户的 rank 始终为 null

- **WHEN** 访问 root 系统用户（id='0'）的 profile
- **THEN** 响应对象包含 `rank: null`（root 不计入榜单）

#### Scenario: rank 字段不影响其他字段

- **WHEN** `GET /api/v1/users/:id/profile` 响应包含 rank
- **THEN** 现有字段（username、bio、stats、solved_problems、recent_submissions、created_at）的存在性与值不因 rank 字段的添加而改变