## Why

Neuro OJ 绝大多数实体使用 UUID 作为主键，并在前端 URL、API 路径、列表展示中直接透传完整 UUID。URL 不可读、列表只能截断展示，且题目已有可读 `display_id` 但前端使用不统一。需求方确认：UUID 仅作为内部主键，所有用户可见实体获得稳定的公开标识，前端（含 admin）全面切换，API 保持 UUID 兼容。

## What Changes

- 为 `contests`、`trainings`、`submissions`、`community_posts`、`announcements` 新增不可变 `public_id` 唯一列。
- 用户公开标识使用 `username`，题目沿用 `display_id`。
- 后端路由支持 UUID / `public_id` / `display_id` / `username` 双解析。
- 前端（含 admin）URL、展示、API 调用切换为公开标识。
- 内部实体（私信会话/消息、自测、评论、澄清、题目小题）保持 UUID。

## Capabilities

### Modified Capabilities
- `database-schema`: 5 张业务表新增 `public_id` 唯一非空列。

### New Capabilities
- `public-identifiers`: 公开标识生成规则、双解析语义、前端 URL 规则。

## Impact

- noj-core：新增迁移、service 创建逻辑、路由解析、响应字段。
- noj-ui：URL/展示/API 全面切换，含 admin。
- 不删除 UUID 主键，不破坏旧链接。
