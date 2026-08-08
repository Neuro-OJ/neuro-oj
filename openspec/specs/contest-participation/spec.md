## Purpose

定义竞赛参与功能规范，包括竞赛注册（公开注册/密码保护/管理员邀请）、竞赛提交与提交列表。
## Requirements
### Requirement: 竞赛注册

系统 SHALL 支持两种参赛方式：公开自由注册和管理员邀请。

- `POST /api/v1/contests/:id/register` — 用户注册参赛（需登录）
- 公开竞赛 (`is_public=true`, `password=NULL`)：任何登录用户可直接注册
- 密码保护竞赛 (`is_public=true`, `password` 非空)：需提供正确密码
- 非公开竞赛 (`is_public=false`)：仅管理员可通过管理端点添加参与者

注册前 SHALL 检查竞赛状态非 `ended`。重复注册同一竞赛 SHALL 返回 409。

#### Scenario: 自由注册公开竞赛
- **WHEN** 已登录用户 POST `/api/v1/contests/<public-contest-id>/register`
- **THEN** 系统返回 201，用户被添加为参赛者

#### Scenario: 密码保护竞赛注册
- **WHEN** 已登录用户 POST `/api/v1/contests/<password-protected-id>/register` 并提供正确密码
- **THEN** 系统返回 201，用户被添加为参赛者

#### Scenario: 密码错误被拒
- **WHEN** 已登录用户 POST `/api/v1/contests/<password-protected-id>/register` 但密码错误
- **THEN** 系统返回 403

#### Scenario: 管理员邀请参赛者
- **WHEN** 管理员 POST `/api/v1/admin/contests/:id/participants` 传入 `["user1-uuid", "user2-uuid"]`
- **THEN** 系统返回 201，两位用户被添加为参赛者

#### Scenario: 竞赛结束后无法注册
- **WHEN** 已登录用户 POST `/api/v1/contests/<ended-contest-id>/register`
- **THEN** 系统返回 403

### Requirement: 竞赛提交

系统 SHALL 提供 `POST /api/v1/contests/:id/submit` 端点（需登录），允许参赛者在竞赛期间提交代码。

提交流程 SHALL 复用现有 `createSubmission`，额外校验：
1. 竞赛状态为 `running`
2. 用户已注册参赛
3. `problem_id` 属于该竞赛的 `contest_problems`

提交成功 SHALL 自动将 `submissions.contest_id` 设为当前竞赛 ID。

#### Scenario: 竞赛期间提交代码
- **WHEN** 已注册用户在 running 竞赛中 POST `/api/v1/contests/<id>/submit` 提交有效代码
- **THEN** 系统返回 201，submission 被创建且 `contest_id` 指向该竞赛，评测任务入队

#### Scenario: 竞赛未开始提交被拒
- **WHEN** 已注册用户在 pending 竞赛中尝试提交
- **THEN** 系统返回 403

#### Scenario: 未注册用户提交被拒
- **WHEN** 未注册用户在 running 竞赛中尝试提交
- **THEN** 系统返回 403

#### Scenario: 提交非竞赛题目
- **WHEN** 参赛者 POST `/api/v1/contests/<id>/submit` 但 problem_id 不属于该竞赛
- **THEN** 系统返回 400

### Requirement: 竞赛内提交列表

系统 SHALL 提供竞赛内提交查询端点。

- `GET /api/v1/contests/:id/my-submissions` — 当前用户在本竞赛的所有提交（需登录 + 参赛）
- admin 可通过 `GET /api/v1/admin/contests/:id/submissions` 查看竞赛全部提交

#### Scenario: 查看自己在竞赛中的提交
- **WHEN** 参赛者 GET `/api/v1/contests/<id>/my-submissions`
- **THEN** 系统返回该用户在本竞赛中的所有提交，包含评测结果

#### Scenario: 竞赛期间查看他人提交被拒
- **WHEN** 参赛者 A 尝试通过 my-submissions 接口查看参赛者 B 的提交
- **THEN** my-submissions 接口仅返回当前用户的提交，无法查看他人

### Requirement: 竞赛客观题提交

系统 SHALL 支持参赛者在竞赛中提交客观题套卷答案，使用 `POST /api/v1/problems/:id/submit` 并携带 `contest_id`。提交前 SHALL 校验：竞赛存在且状态为 `running`、用户已注册参赛、套卷属于该竞赛的 contest_problems、该用户对该套卷在该竞赛下无既有提交（只允许一次）。

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

