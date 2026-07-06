## Purpose

定义用户封禁操作的数据持久化及审计追踪，通过 `user_bans` 表记录完整的封禁/解封操作历史。

## Requirements

### Requirement: user_bans 表 schema

系统 SHALL 提供 `user_bans` 表追踪用户封禁/解封操作。表结构 SHALL 包含：

- `id` TEXT PRIMARY KEY
- `user_id` TEXT NOT NULL REFERENCES `users(id)` ON DELETE CASCADE
- `reason` TEXT NOT NULL DEFAULT ''
- `banned_until` TEXT（ISO 8601；NULL = 永久）
- `banned_at` TEXT NOT NULL
- `banned_by` TEXT REFERENCES `users(id)` ON DELETE SET NULL
- `unbanned_at` TEXT（NULL = 当前活跃封禁）
- `unbanned_by` TEXT REFERENCES `users(id)` ON DELETE SET NULL

索引：
- `idx_user_bans_active`：部分索引 `(user_id) WHERE unbanned_at IS NULL`（加速活跃封禁查询）
- `idx_user_bans_user`：`(user_id)`（封禁历史查询）

#### Scenario: 新建表

- **WHEN** 全新部署 noj-core
- **THEN** 迁移 0013 创建 `user_bans` 表，索引生效

#### Scenario: 已存在则跳过

- **WHEN** `user_bans` 表已存在
- **THEN** `CREATE TABLE IF NOT EXISTS` 幂等通过

### Requirement: 封禁操作写入 user_bans

`banUser()` SHALL 执行两步写入：

1. UPDATE `user_bans SET unbanned_at=now() WHERE user_id=targetId AND unbanned_at IS NULL`（关闭已有活跃封禁）
2. INSERT 新行到 `user_bans`，`banned_at=now()`, `unbanned_at=NULL`

`unbanUser()` SHALL UPDATE `user_bans SET unbanned_at=now(), unbanned_by=actorId WHERE user_id=targetId AND unbanned_at IS NULL`。

操作后 SHALL 调 `invalidateBanCache({ userId: targetId })` 立即失效缓存。

#### Scenario: 首次封禁

- **WHEN** 用户无活跃封禁
- **AND** admin 调用 `PATCH /api/v1/admin/users/:id/ban`
- **THEN** `user_bans` 新增一条记录，`unbanned_at IS NULL`

#### Scenario: 再次封禁（覆盖旧封禁）

- **WHEN** 用户已有活跃封禁（如永久封禁，reason="刷提交"）
- **AND** admin 再次封禁（7 天，reason="滥用 API"）
- **THEN** 旧记录 `unbanned_at` 被设为当前时间，新记录的 `reason="滥用 API"`, `banned_until=7天后`, `unbanned_at IS NULL`

#### Scenario: 解封

- **WHEN** admin 调用 `PATCH /api/v1/admin/users/:id/unban`
- **THEN** 活跃封禁记录 `unbanned_at` 被设为当前时间，`unbanned_by` 设为操作人 ID

### Requirement: 封禁历史查询

系统 SHALL 提供 `GET /api/v1/admin/users/:id/bans` 端点，返回该用户所有封禁历史（按 `banned_at DESC`）：

```json
{
  "data": [{
    "id": "uuid",
    "reason": "...",
    "banned_until": "2026-12-31T00:00:00Z",
    "banned_at": "2026-07-01T10:00:00Z",
    "banned_by": { "id": "uuid", "username": "admin" },
    "unbanned_at": "2026-07-02T00:00:00Z",
    "unbanned_by": { "id": "uuid", "username": "admin" }
  }]
}
```

端点 SHALL 需要管理员认证。

#### Scenario: 查询用户封禁历史

- **WHEN** admin 调用 `GET /api/v1/admin/users/:id/bans`
- **THEN** 返回 200，`data` 按时间倒序排列

#### Scenario: 无封禁历史的用户

- **WHEN** admin 调用 `GET /api/v1/admin/users/:id/bans`
- **AND** 该用户从未被封禁
- **THEN** 返回 200，`data: []`

### Requirement: users 表移除封禁列

迁移 0013 SHALL 从 `users` 表删除 `banned`, `banned_reason`, `banned_until` 三列：

```sql
ALTER TABLE users DROP COLUMN IF EXISTS banned;
ALTER TABLE users DROP COLUMN IF EXISTS banned_reason;
ALTER TABLE users DROP COLUMN IF EXISTS banned_until;
```

`UserResponse` 类型 SHALL 移除 `banned / banned_reason / banned_until` 字段，改为计算字段 `active_ban: { reason, banned_until } | null`（从 `user_bans` 子查询获取）。

#### Scenario: 列已存在则删除

- **WHEN** 0012 已执行（users 有三列）
- **THEN** 0013 `DROP COLUMN IF EXISTS` 成功

#### Scenario: 列不存在则幂等

- **WHEN** 全新部署（users 从未有过这三列）
- **THEN** `DROP COLUMN IF EXISTS` 幂等通过
