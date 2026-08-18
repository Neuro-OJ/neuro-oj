## Purpose

定义竞赛答疑（Clarification）功能规范，包括参赛者提问、主办方回复、可见性控制、通知集成与竞赛详情页答疑面板。

## Requirements

### Requirement: 参赛者提问

系统 SHALL 提供竞赛答疑提问端点 `POST /api/v1/contests/:id/clarifications`，供参赛者在竞赛进行期间提出问题。

- 仅已注册参赛者可提问；未登录用户 MUST 收到 401，已登录但未参赛用户 MUST 收到 403
- 竞赛状态 MUST 为 `running`；`pending` / `ended` 期间提问 MUST 收到 403
- 请求体：`content`（必填，非空，≤ 5000 字符）、`problem_id`（可选）
- `problem_id` 提供时 MUST 属于该竞赛（存在于 `contest_problems`），否则 400；省略时为全局提问
- 提问记录 `is_public` 固定为 `true`（进入公开答疑流），`reply_to_id` 为 NULL

#### Scenario: 参赛者挂题目提问
- **WHEN** 已参赛用户 POST `/api/v1/contests/<running-contest-id>/clarifications`，body 含 `content` 与属于该竞赛的 `problem_id`
- **THEN** 系统返回 201，创建一条 `is_public=true` 的提问，`problem_id` 正确关联

#### Scenario: 参赛者全局提问
- **WHEN** 已参赛用户 POST `/api/v1/contests/<running-contest-id>/clarifications`，body 仅含 `content`（无 `problem_id`）
- **THEN** 系统返回 201，创建一条 `problem_id` 为 NULL 的全局提问

#### Scenario: 非参赛者提问被拒
- **WHEN** 未注册该竞赛的已登录用户 POST `/api/v1/contests/<running-contest-id>/clarifications`
- **THEN** 系统返回 403

#### Scenario: 匿名提问被拒
- **WHEN** 未登录用户 POST `/api/v1/contests/<running-contest-id>/clarifications`
- **THEN** 系统返回 401

#### Scenario: 竞赛非进行期间提问被拒
- **WHEN** 已参赛用户对 `pending` 或 `ended` 状态的竞赛 POST `/api/v1/contests/<id>/clarifications`
- **THEN** 系统返回 403

#### Scenario: 提问挂接不属于该竞赛的题目被拒
- **WHEN** 已参赛用户 POST `/api/v1/contests/<running-contest-id>/clarifications`，`problem_id` 不属于该竞赛
- **THEN** 系统返回 400

#### Scenario: 空内容提问被拒
- **WHEN** 已参赛用户 POST `/api/v1/contests/<running-contest-id>/clarifications`，`content` 为空或仅空白
- **THEN** 系统返回 400

### Requirement: 主办方回复

系统 SHALL 提供答疑回复端点 `POST /api/v1/contests/:id/clarifications/:clarId/reply`，仅 admin（拥有 `admin:full_access`）或竞赛创建者（`contests.created_by`）可调用。

- 请求体：`content`（必填，非空，≤ 5000 字符）、`is_public`（必填布尔值）
- 回复目标 `clarId` MUST 是同一竞赛下的一条提问（`reply_to_id IS NULL`），目标不存在返回 404；目标为回复本身返回 400
- `is_public=true` 的回复对全员可见；`is_public=false` 的私密回复仅提问者与 admin/创建者可见
- 回复成功后将写入一条 `community_notifications` 通知（type `clarification`，recipient 为提问者，data 含 `contest_id` / `clarification_id` / `problem_label` / `is_public`），并经现有 SSE 用户频道推送 `notification:new`；回复者为提问者本人时 MUST 不产生通知

#### Scenario: 主办方公开回复
- **WHEN** admin POST `/api/v1/contests/<id>/clarifications/<clarId>/reply`，body 含 `content` 与 `is_public=true`
- **THEN** 系统返回 201，创建一条公开回复；提问者收到 type 为 `clarification` 的通知，SSE 推送 `notification:new`

#### Scenario: 主办方私密回复
- **WHEN** 竞赛创建者 POST `/api/v1/contests/<id>/clarifications/<clarId>/reply`，body 含 `content` 与 `is_public=false`
- **THEN** 系统返回 201，创建一条私密回复，仅提问者与 admin/创建者可见

#### Scenario: 非主办方回复被拒
- **WHEN** 普通参赛者 POST `/api/v1/contests/<id>/clarifications/<clarId>/reply`
- **THEN** 系统返回 403

#### Scenario: 回复不存在的提问
- **WHEN** 主办方 POST `/api/v1/contests/<id>/clarifications/<不存在-id>/reply`
- **THEN** 系统返回 404

#### Scenario: 回复的回复被拒
- **WHEN** 主办方对一条回复（非提问）POST `/api/v1/contests/<id>/clarifications/<replyId>/reply`
- **THEN** 系统返回 400

#### Scenario: 提问者被自己回复不产生通知
- **WHEN** 提问者本人（同时是竞赛创建者）回复自己的提问
- **THEN** 系统返回 201，但不产生任何通知

### Requirement: 答疑列表可见性

系统 SHALL 提供答疑列表端点 `GET /api/v1/contests/:id/clarifications`（可选登录），返回按时间升序的线程结构（提问 + 其下回复）。

- 未登录或未参赛用户：仅可见公开问答（提问与 `is_public=true` 的回复）
- 参赛者：可见全部公开问答 + 自己的提问及挂在其下的私密回复；其他参赛者的私密回复不可见
- admin / 竞赛创建者：可见全部（含所有私密回复）
- 私有竞赛（`is_public=false`）MUST 仅对 admin/参赛者（含创建者）开放列表；其他用户（含未登录）MUST 收到 404，与 `GET /:id` 门禁一致（避免泄露私有竞赛存在性）
- 分页基于提问数（`page` / `perPage`，默认 20，上限 100），回复跟随其根提问返回
- 响应包含 `problem_id` 对应的竞赛题目标签 `problem_label`（全局提问为 null）

#### Scenario: 参赛者查看答疑列表
- **WHEN** 已参赛用户 GET `/api/v1/contests/<id>/clarifications`
- **THEN** 系统返回全部公开问答，以及该用户自己的提问（含其私密回复），不包含其他用户的私密回复

#### Scenario: 未参赛者仅见公开答疑
- **WHEN** 未参赛用户（或匿名）GET `/api/v1/contests/<public-contest-id>/clarifications`
- **THEN** 系统仅返回公开问答，所有私密回复均不出现

#### Scenario: 非参赛者访问私有竞赛答疑列表被拒
- **WHEN** 未注册私有竞赛的用户（或匿名）GET `/api/v1/contests/<private-contest-id>/clarifications`
- **THEN** 系统返回 404

#### Scenario: 主办方查看全部答疑
- **WHEN** admin 或竞赛创建者 GET `/api/v1/contests/<id>/clarifications`
- **THEN** 系统返回全部提问与回复（含所有私密回复）

### Requirement: 答疑通知集成

系统 SHALL 复用现有社区通知系统承载答疑回复通知，使提问者收到实时提醒。

- 通知持久化于 `community_notifications`，type 枚举扩展 `clarification`
- 通知 `data` 记录 `contest_id`、`clarification_id`（根提问）、`problem_label`、`is_public`
- SSE：复用 `Channels.user(提问者)` 推送 `notification:new`（现有 `publishEvent` 机制，无需新频道）
- 通知中心（`/community/notifications`）SHALL 展示该类型（文案"回复了你的竞赛提问"），点击跳转 `/contests/{contest_id}?tab=clarifications`
- 通知在竞赛答疑数据不存在时跳转仍可用（落地到竞赛页，不产生 404）

#### Scenario: 通知中心展示答疑回复
- **WHEN** 提问者打开 `/community/notifications`，其提问已被主办方回复
- **THEN** 通知列表出现 type 为 `clarification` 的条目，展示回复者用户名与"回复了你的竞赛提问"，点击跳转到对应竞赛的答疑面板

#### Scenario: 答疑通知触发 SSE 提醒
- **WHEN** 主办方回复提问者 A 的提问
- **THEN** A 的 SSE 用户频道收到 `notification:new` 事件，Navbar 未读角标刷新

### Requirement: 竞赛详情页答疑面板

系统 SHALL 在竞赛详情页提供答疑面板 UI，页面以 Tabs 组织（详情 / 题目 / 答疑 / 排名）。

- tab 状态 SHALL 同步至 URL query `?tab=`，刷新与分享保持；`/contests/:id/ranking` 既有 URL 继续可用
- 答疑面板包含：提问表单（仅竞赛进行期间且已参赛用户可见；题目下拉含"全局提问"与竞赛题目）、线程列表（提问 + 回复缩进展示，公开回复标记"公开"、私密回复标记"仅你可见"）
- admin/竞赛创建者：每个提问下显示回复表单，公开/私密二选一
- 参赛者收到 `notification:new` 事件时，若答疑面板处于激活状态则静默刷新列表

#### Scenario: 参赛者在答疑面板提问
- **WHEN** 已参赛用户在竞赛进行期间打开竞赛详情页答疑 tab，填写内容并提交
- **THEN** 提问出现在公开答疑流中，表单清空

#### Scenario: 主办方在答疑面板回复
- **WHEN** admin/竞赛创建者在答疑 tab 对某提问选择"公开"并回复
- **THEN** 回复出现在该提问下并标记为公开，提问者收到通知

#### Scenario: 私密回复仅提问者可见
- **WHEN** 主办方对提问者 A 的提问选择"私密"回复
- **THEN** A 在答疑面板看到该回复（标记"仅你可见"），其他参赛者与未参赛者不可见

#### Scenario: 非参赛者不可见提问表单
- **WHEN** 未参赛用户打开竞赛详情页答疑 tab
- **THEN** 页面不显示提问表单，仅展示公开答疑流
