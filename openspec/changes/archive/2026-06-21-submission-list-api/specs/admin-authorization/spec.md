## ADDED Requirements

### Requirement: 管理员可查看所有用户提交

系统 SHALL 提供 `GET /api/v1/admin/submissions`
端点，允许管理员查看所有用户的提交列表。

此端点 MUST 依次通过 `authMiddleware` 和 `adminMiddleware`
保护。支持与用户提交列表接口相同的分页和筛选参数，额外支持 `user_id`
查询参数按用户筛选。

详细规范见 `submission-list-api` spec 中「管理员查询所有用户提交」需求。

#### Scenario: 管理员成功查询

- **WHEN** 管理员 GET `/api/v1/admin/submissions`
- **THEN** 系统返回提交列表和分页信息

#### Scenario: 普通用户被拒绝

- **WHEN** 普通用户（role=user）携带有效 JWT 访问 `/api/v1/admin/submissions`
- **THEN** 系统返回 403，错误消息 `"需要管理员权限"`
