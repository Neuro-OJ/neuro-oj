## Why

当前 `users` 表用三列（`banned / banned_reason / banned_until`）追踪封禁状态，解封后历史丢失——无法审计该用户是否被历史封禁过、谁封的、有过几次封禁。改用 `user_bans` 表（与 `ip_bans` 同模式），一条记录 = 一次封禁操作，解封只是追加 `unbanned_at`，历史完整可追溯。旧数据无需迁移（未投入生产环境，直接改表结构即可）。

## What Changes

- **BREAKING**: 从 `users` 表删除 `banned / banned_reason / banned_until` 三列
- **新增** `user_bans` 表：每次封禁生成一条记录（含 `banned_by`、`unbanned_by` 审计字段）
- **修改** `banUser()`：INSERT 前先关闭已有活跃封禁（`UPDATE ... SET unbanned_at=now`），再 INSERT 新记录（方案 A：以最新为准）
- **修改** `unbanUser()`：UPDATE 目标记录 `unbanned_at=now, unbanned_by=actorId`
- **修改** `getUserBanState()`：从查 `users` 表改为查 `user_bans` WHERE `unbanned_at IS NULL`
- **修改** `listUsers()`/`toUserResponse()`：活跃封禁状态从 JOIN `user_bans` 获取（或子查询）
- **新增** `GET /api/v1/admin/users/:id/bans`：查询用户完整封禁历史
- **修改** 前端 admin/users.vue："封禁历史"可展开查看

## Capabilities

### New Capabilities
- `user-ban-audit`: `user_bans` 表 + 封禁历史查询端点，支持审计追溯

### Modified Capabilities
- `user-ban`: `users` 封禁列改为 `user_bans` 表；封禁/解封逻辑改为 INSERT/UPDATE 行；中间件和 service 查询路径适配

## Impact

- **数据库**：删除 `users.banned, banned_reason, banned_until`（迁移 0013）；新增 `user_bans` 表
- **noj-core**：
  - `src/db/schema.ts` / `schema-ddl.ts`：删除 users 三列 + 新增 userBans 表定义
  - `src/services/users.ts`：`banUser()`/`unbanUser()` 改为写入 `user_bans`
  - `src/middleware/auth.ts`：`getUserBanState()` 改为查 `user_bans`
  - `src/services/auth.ts`：`loginUser()`、`toUserResponse()`、`listUsers()` 适配
  - `src/routes/admin.ts`：新增 ban 历史端点
  - `src/types/auth.ts`：`UserResponse` 字段可能简化（`banned` 变为计算字段）
- **noj-ui**：
  - `pages/admin/users.vue`：新增封禁历史展开面板
  - `composables/useBanStatus.ts`：`BanStatusResponse` 适配
- **无数据迁移**：旧迁移 0012 中 ban 三列被新迁移 0013 回滚
