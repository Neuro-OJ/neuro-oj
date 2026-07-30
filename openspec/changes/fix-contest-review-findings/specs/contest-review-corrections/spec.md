## ADDED Requirements

### Requirement: 竞赛结束后的题目访问

系统 SHALL 允许任意已登录用户查看已结束竞赛的题目列表和单题详情。赛前题目仍不可见；进行中的竞赛题目仍仅限参赛者访问。

#### Scenario: 非参赛者查看已结束竞赛题目

- **WHEN** 已登录但未参赛的用户请求已结束竞赛的题目列表或单题详情
- **THEN** 系统返回对应的竞赛题目数据

#### Scenario: 非参赛者查看进行中竞赛题目

- **WHEN** 已登录但未参赛的用户请求进行中竞赛的题目列表或单题详情
- **THEN** 系统返回 403

### Requirement: ICPC 平局的确定性排序

系统 SHALL 先按 `solved_count DESC`、`total_penalty ASC` 和 `last_ac_time ASC` 排序 ICPC 排名。当这三个字段均相同时，系统 MUST 依次按 `registered_at ASC` 和 `user_id ASC` 产生稳定的名次顺序。

#### Scenario: ICPC 成绩完全相同时按报名时间排序

- **WHEN** 两名参赛者的解题数、总罚时和最后通过时间相同，但报名时间不同
- **THEN** 报名更早的参赛者排名更靠前

#### Scenario: ICPC 成绩与报名时间相同时按用户 ID 排序

- **WHEN** 两名参赛者的解题数、总罚时、最后通过时间和报名时间均相同
- **THEN** 用户 ID 按升序较小的参赛者排名更靠前
