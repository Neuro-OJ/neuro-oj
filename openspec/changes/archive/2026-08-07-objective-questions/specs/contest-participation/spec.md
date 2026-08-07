## ADDED Requirements

### Requirement: 竞赛客观题提交

系统 SHALL 支持参赛者在竞赛中提交客观题套卷答案，使用 `POST /api/v1/objective/papers/:id/submit` 并携带 `contest_id`。提交前 SHALL 校验：竞赛存在且状态为 `running`、用户已注册参赛、套卷属于该竞赛的 contest_problems、该用户对该套卷在该竞赛下无既有提交（只允许一次）。

#### Scenario: 竞赛期间提交套卷答案
- **WHEN** 已注册参赛者在 running 竞赛中提交该竞赛题单内套卷的答案（首次）
- **THEN** 系统即时判定并返回结果，提交记录含 contest_id，submission_type='contest'

#### Scenario: 竞赛重复提交被拒
- **WHEN** 参赛者对同一套卷在同一竞赛中第二次提交
- **THEN** 系统返回 HTTP 400（或 409），不产生新记录

#### Scenario: 竞赛未进行时提交被拒
- **WHEN** 参赛者在竞赛开始前或结束后提交套卷答案
- **THEN** 系统返回 HTTP 403

#### Scenario: 未注册用户竞赛提交被拒
- **WHEN** 未注册用户在 running 竞赛中提交套卷答案
- **THEN** 系统返回 HTTP 403

#### Scenario: 提交非本竞赛题单套卷被拒
- **WHEN** 参赛者提交的套卷不在该竞赛的 contest_problems 中
- **THEN** 系统返回 HTTP 400
