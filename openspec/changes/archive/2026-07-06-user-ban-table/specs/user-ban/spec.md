## MODIFIED Requirements

### Requirement: 用户封禁状态校验

`noj-core` SHALL 在 `authMiddleware` 中查询 `user_bans` 表的活跃封禁记录（`unbanned_at IS NULL`），命中则抛 `ForbiddenError("账号已被封禁", "USER_BANNED", { reason, until })`。

活跃封禁判定 SHALL 使用 `getUserBanState(userId)`，该函数从 `user_bans` 表查询（替换原先从 `users` 表查询三列的方式）：

```typescript
SELECT * FROM user_bans WHERE user_id = ? AND unbanned_at IS NULL LIMIT 1
```

封禁检查 SHALL 遵循"方法限制 + 最小白名单"策略（继承 ban-status-endpoint Decision 1）：
- GET/HEAD/OPTIONS → 放行
- POST/PUT/PATCH/DELETE → 检查封禁状态
- 白名单：`/api/v1/auth/logout`

校验 SHALL 60s TTL LRU 缓存 `userId → BanState`。`banUser` / `unbanUser` 写入时调用 `invalidateBanCache(userId)` 立即失效。

#### Scenario: 已封禁用户写操作 403

- **WHEN** `user_bans` 中该用户有一条活跃封禁记录（`unbanned_at IS NULL`）
- **AND** 携带有效 JWT 调用写操作端点
- **THEN** 响应 403 + `USER_BANNED` + `{ reason, until }`

#### Scenario: 无活跃封禁用户放行

- **WHEN** `user_bans` 中该用户无活跃封禁记录（所有记录 `unbanned_at IS NOT NULL`）
- **AND** 携带有效 JWT 访问
- **THEN** 不抛错，正常路由

#### Scenario: 临时封禁到期

- **WHEN** `user_bans` 中唯一活跃记录 `banned_until < now`
- **AND** 携带有效 JWT 调用写操作端点
- **THEN** 不抛错，正常路由（业务层判断过期）

### Requirement: 管理员用户封禁端点

`noj-core` SHALL 提供 2 个 admin 端点：

| 方法 | 路径 | body | 响应 |
|------|------|------|------|
| PATCH | `/api/v1/admin/users/:id/ban` | `{ reason?, banned_until? }` | `{ data: User }` 200 |
| PATCH | `/api/v1/admin/users/:id/unban` | — | `{ data: User }` 200 |

业务规则（继承 PR #108）：
- 禁止封禁 root（`targetUserId === '0'`），返 400
- 禁止封禁自己，返 400
- 禁止封禁最后一个可登录 admin，返 400
- 目标用户必须存在，否则返 404
- `banned_until`（如提供）必须是有效 ISO 8601

封禁时 SHALL：
1. UPDATE 关闭已有活跃封禁（`SET unbanned_at=now() WHERE user_id=? AND unbanned_at IS NULL`）
2. INSERT 新封禁记录
3. 返回 Updated `UserResponse`

解封时 SHALL：
1. UPDATE 活跃封禁（`SET unbanned_at=now(), unbanned_by=? WHERE user_id=? AND unbanned_at IS NULL`）
2. 返回 Updated `UserResponse`

审计日志（延续 issue #99 模式）：`console.log("[admin] actor=... action=PUT key=user_ban|user_unban value=...")`。

#### Scenario: 封禁用户（永久）

- **WHEN** admin 调用 `PATCH /api/v1/admin/users/<id>/ban` body=`{ reason: "spam" }`
- **THEN** `user_bans` 新增记录（`banned_until=null, unbanned_at=NULL`），响应 200

#### Scenario: 封禁覆盖旧封禁

- **WHEN** admin 调用 `PATCH /api/v1/admin/users/<id>/ban` body=`{ reason: "新原因" }`
- **AND** 用户已有活跃封禁记录
- **THEN** 旧记录 `unbanned_at` 设为当前时间，新记录写入

#### Scenario: 解封用户

- **WHEN** admin 调用 `PATCH /api/v1/admin/users/<id>/unban`
- **THEN** 活跃封禁记录 `unbanned_at` 设为当前时间，响应 200

### Requirement: 前端用户封禁交互

`noj-ui/pages/admin/users.vue` SHALL 在表格操作列显示封禁/解封按钮（按活跃封禁状态切换文案）。

用户列表 API 返回的 `UserResponse.active_ban` SHALL 包含当前活跃封禁的 `reason` 和 `banned_until`。

`noj-ui/pages/admin/users.vue` SHALL 在行内提供"封禁历史"展开面板（调 `GET /api/v1/admin/users/:id/bans`），展示完整封禁/解封时间线。

#### Scenario: 封禁历史展开

- **WHEN** admin 点击用户行的"封禁历史"按钮
- **THEN** 展开面板显示该用户所有封禁/解封记录（时间、原因、操作人）
