## 1. DB 迁移 0013

- [x] 1.1 创建 `drizzle/0013_user_bans.sql`：DROP `users.banned*` 三列 + CREATE `user_bans` 表 + 索引
- [x] 1.2 更新 `drizzle/meta/_journal.json`：新增 0013 迁移条目
- [x] 1.3 更新 `src/db/schema-ddl.ts`：删除 users 三列 + 新增 userBans 表 DDL

## 2. ORM Schema + 类型

- [x] 2.1 更新 `src/db/schema.ts`：新增 `userBans` Drizzle 表定义 + 删除 `users` 表 `banned/banned_reason/banned_until` 字段
- [x] 2.2 更新 `src/types/auth.ts`：`UserResponse` 移除直列字段，改为 `active_ban: { reason, banned_until } | null`

## 3. Service 层

- [x] 3.1 修改 `src/services/users.ts`：`banUser()` 改为两步写入 `user_bans`；`unbanUser()` 改为 UPDATE `user_bans`
- [x] 3.2 修改 `src/services/auth.ts`：`toUserResponse()` 适配新 `UserResponse`；`listUsers()` 用 LEFT JOIN 获取活跃封禁
- [x] 3.3 修改 `loginUser()`：封禁检查从读 `users` 列改为查 `user_bans`

## 4. Middleware

- [x] 4.1 修改 `src/middleware/auth.ts`：`getUserBanState()` 从查 `users` 表切到查 `user_bans` 表

## 5. Routes

- [x] 5.1 新增 `GET /api/v1/admin/users/:id/bans` 端点（封禁历史）
- [x] 5.2 修改 `PATCH /api/v1/admin/users/:id/ban`（适配 `banUser` 新返回值）
- [x] 5.3 验证 `GET /api/v1/auth/ban-status` 无需修改（`getUserBanState` 内部切换即可）

## 6. 前端

- [x] 6.1 `noj-ui/composables/useAuth.ts`：接口已适配 `active_ban`（banned 列已提前移除）
- [x] 6.2 `noj-ui/pages/admin/users.vue`：适配 `active_ban` 字段 + 新增封禁历史弹窗

## 7. 测试

- [ ] 7.1 新增 `tests/services/user-bans.test.ts`：封禁历史写入 + 覆盖旧封禁 + 解封（延后补充）
- [x] 7.2 更新 `tests/middleware/banlist.test.ts`：`getUserBanState` 适配 `user_bans` 表
- [x] 7.3 全量测试通过（374 passed | 1 pre-existing flaky）
- [x] 7.4 deno fmt + deno lint 通过
