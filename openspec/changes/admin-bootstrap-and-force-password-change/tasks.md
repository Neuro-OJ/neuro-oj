## 1. 数据库 Migration

- [ ] 1.1 创建 `drizzle/0006_must_change_password.sql`：为 `users` 表新增
  `must_change_password BOOLEAN NOT NULL DEFAULT false` 列
- [ ] 1.2 更新 `src/db/schema.ts`：`users` 表追加
  `must_change_password: boolean("must_change_password").notNull().default(false)`
- [ ] 1.3 同步更新 `drizzle/meta/_journal.json` 与 `_snapshot.json`

## 2. JWT 与类型扩展

- [ ] 2.1 在 `src/lib/jwt.ts` 的 `TokenPayload` 接口中新增
  `must_change_password: boolean` 字段
- [ ] 2.2 在 `src/types/auth.ts` 的 `UserResponse` 接口中新增
  `must_change_password: boolean` 字段
- [ ] 2.3 修改 `src/services/auth.ts` 的 `toUserResponse()`：输出
  `must_change_password` 字段

## 3. 服务层：登录与改密

- [ ] 3.1 修改 `src/services/auth.ts` 的 `loginUser()`：调用 `signToken()` 时
  传入 `must_change_password`，响应 user 包含该字段
- [ ] 3.2 在 `src/services/auth.ts` 中新增 `changePassword()` 函数：
  - 接收 `userId, oldPassword, newPassword`
  - 复用 `validatePasswordStrength()`
  - 校验 `oldPassword` 与 DB hash 一致
  - 更新 `password_hash` 与 `must_change_password=false`
- [ ] 3.3 在 `src/types/auth.ts` 中新增 `ChangePasswordInput` 类型

## 4. 中间件拦截

- [ ] 4.1 在 `src/middleware/auth.ts` 中新增 `PASSWORD_CHANGE_WHITELIST`
  常量（包含 `/api/v1/auth/change-password`、`/api/v1/auth/me`、
  `/api/v1/auth/logout`）
- [ ] 4.2 修改 `authMiddleware`：解析 JWT 后检查
  `payload.must_change_password`；为 true 且路径不在白名单则返回 403 +
  `code: PASSWORD_CHANGE_REQUIRED`
- [ ] 4.3 在 `src/middleware/auth.ts` 中将 `userId/userRole` 同时写入
  `c.set("mustChangePassword", payload.must_change_password)`（便于下游使用）

## 5. 路由层：改密端点

- [ ] 5.1 在 `src/routes/auth.ts` 中新增 `POST /api/v1/auth/change-password`
  路由，受 `authMiddleware` 保护
- [ ] 5.2 路由 handler 调用 `changePassword()`，返回 200 + `{ data: { ...user } }`

## 6. 种子脚本：引导管理员

- [ ] 6.1 在 `scripts/seed.ts` 中新增 `ensureBootstrapAdmin()` 函数：
  - 查询"可登录 admin"（`role='admin' AND id != '0'`）数量，>0 则跳过
  - 生成 24 字符 base64url 强密码
  - 用 `username='admin'`、`email='admin@noj.local'` 插入 users 表，
    `must_change_password=true`
  - 以醒目格式（带 `⚠`）打印临时凭证到终端
- [ ] 6.2 修改 `ensureAdminFromEnv()` 注释：当 `ADMIN_EMAIL` 已设置且对应用
  户存在时，确保其 `must_change_password` 被正确处理（沿用 DB 现有值）
- [ ] 6.3 在 `deno task seed` 主流程中：`ensureRootUser()` 后调用
  `ensureBootstrapAdmin()`

## 7. 前端：User 类型与 useAuth

- [ ] 7.1 修改 `noj-ui/composables/useAuth.ts`：`User` 接口新增
  `must_change_password: boolean`
- [ ] 7.2 修改登录成功处理：根据 `user.must_change_password` 分流——true 跳
  `/change-password`，否则跳原 redirect 或首页
- [ ] 7.3 修改 `useAuth` 的 `setUser`：写入 user state 时持久化
  `must_change_password` 字段

## 8. 前端：路由守卫

- [ ] 8.1 修改 `noj-ui/middleware/auth.ts`：已登录用户访问非 `/change-password`
  路由时，若 `must_change_password=true` 则 `navigateTo('/change-password')`
- [ ] 8.2 修改 `noj-ui/middleware/auth.ts`：`/change-password` 页面允许未带
  must_change_password 的用户访问（兜底）

## 9. 前端：改密页

- [ ] 9.1 新建 `noj-ui/pages/ChangePassword.vue`：两栏表单（old_password 可
  选、new_password、confirm_password），提交后调用
  `/api/v1/auth/change-password`
- [ ] 9.2 提交成功：清 Cookie + 跳 `/login?reason=password_changed`
- [ ] 9.3 提交失败：SweetAlert 错误提示（401 → "原密码错误"）

## 10. 登录速率限制适配

- [ ] 10.1 在 `src/routes/auth.ts` 中将 `POST /api/v1/auth/change-password`
  纳入 issue #73 的速率限制范围（IP 维度），防止暴力改密

## 11. 文档更新

- [ ] 11.1 `README.md` / `AGENTS.md`：新增「创建第一个管理员」小节，描述引
  导流程与强制改密机制
- [ ] 11.2 `noj-core/.env.example`：把 `ADMIN_EMAIL` / `ADMIN_PASS` 注释从
  "可选" 改为 "强烈推荐"

## 12. 测试补充

- [ ] 12.1 新增 `tests/services/auth_change_password_test.ts`：覆盖
  `changePassword()` 正常路径、错误旧密码、弱密码拒绝
- [ ] 12.2 新增 `tests/routes/auth_change_password_test.ts`：覆盖
  `POST /api/v1/auth/change-password` 端点
- [ ] 12.3 新增 `tests/middleware/auth_must_change_test.ts`：覆盖中间件拦截
  与白名单放行
- [ ] 12.4 新增 `tests/seed_bootstrap_admin_test.ts`：覆盖
  `ensureBootstrapAdmin()` 幂等行为
- [ ] 12.5 运行 `deno task test` 确保全部通过

## 13. OpenSpec 规范同步

- [ ] 13.1 通过 `/opsx:sync` 同步 delta specs 到主 spec 目录