## ADDED Requirements

### Requirement: 公开最近提交列表排除竞赛提交

`GET /api/v1/submissions/public/recent` SHALL 只返回非竞赛提交（`contest_id IS NULL`），不得泄露竞赛提交的得分、进度或参赛者信息。

#### Scenario: 公开 recent 不包含竞赛提交

- **WHEN** 匿名用户 GET `/api/v1/submissions/public/recent`，且最近存在竞赛提交与非竞赛提交
- **THEN** 响应仅包含非竞赛提交，不包含任何 `contest_id` 非空的记录

### Requirement: 竞赛提交详情可见性

`GET /api/v1/submissions/:id` 对属于 OI 进行中竞赛的提交，非 owner/admin 查看时 SHALL 隐藏 `result.score` 与 `result.status`（或整体隐藏 result），防止通过详情接口绕过榜单隐藏分数。

#### Scenario: OI 进行中他人提交详情隐藏得分

- **WHEN** 普通用户查看他人提交，且该提交属于 OI 进行中竞赛
- **THEN** 响应中 `result` 为 `null` 或不包含 `score`/`status`

#### Scenario: owner/admin 可查看完整详情

- **WHEN** 提交者本人或 admin 查看同一提交
- **THEN** 响应包含完整 `result`（score/status/output/details）
