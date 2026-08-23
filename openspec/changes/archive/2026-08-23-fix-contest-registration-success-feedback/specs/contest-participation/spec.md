## MODIFIED Requirements

### Requirement: 竞赛注册

系统 SHALL 支持两种参赛方式：公开自由注册和管理员邀请。

- `POST /api/v1/contests/:id/register` — 用户注册参赛（需登录）
- 公开竞赛 (`is_public=true`, `password=NULL`)：任何登录用户可直接注册
- 密码保护竞赛 (`is_public=true`, `password` 非空)：需提供正确密码
- 非公开竞赛 (`is_public=false`)：仅管理员可通过管理端点添加参与者

注册前 SHALL 检查竞赛状态非 `ended`。重复注册同一竞赛 SHALL 返回 409。

报名页面在注册接口返回成功后 SHALL 立即展示报名成功状态。注册成功后的竞赛信息刷新或题目加载失败 SHALL NOT 被当作注册失败显示，也不得诱导用户重复提交注册请求。

#### Scenario: 自由注册公开竞赛
- **WHEN** 已登录用户 POST `/api/v1/contests/<public-contest-id>/register`
- **THEN** 系统返回 201，用户被添加为参赛者，报名页面展示已报名状态

#### Scenario: 报名成功但后续刷新失败
- **WHEN** 注册接口返回 201，但报名页面随后刷新竞赛信息或加载题目失败
- **THEN** 页面仍展示已报名状态，不显示注册失败或网络连接失败提示

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
