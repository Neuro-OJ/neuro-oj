# 任务清单 — Issue #102 IP 黑名单 + 用户封禁

## 1. OpenSpec 提案（已完成规划）

- [x] 1.1 写 `proposal.md`（Why / What / Impact）
- [x] 1.2 写 `design.md`（Context / Goals / Decisions / Risks）
- [x] 1.3 写 `specs/admin-ip-blacklist/spec.md`（8 个 Requirements + 24 个 Scenarios）
- [x] 1.4 写本 tasks.md

## 2. DB 迁移

- [ ] 2.1 写 `noj-core/drizzle/0012_ip_bans_and_user_ban.sql`（建表 + 加列）
- [ ] 2.2 更新 `noj-core/drizzle/meta/_journal.json`（追加 0012 条目）
- [ ] 2.3 同步 `noj-core/src/db/schema.ts`（users 加 3 列 + 新增 ipBans 表）
- [ ] 2.4 同步 `noj-core/src/db/schema-ddl.ts`（SCHEMA_DDL + SCHEMA_INDEXES 数组）

## 3. 基础工具

- [ ] 3.1 `noj-core/src/lib/cidr.ts`：IPv4 工具（ipv4ToInt / parseCidr / isBannedIp）
- [ ] 3.2 `noj-core/src/lib/banCache.ts`：60s TTL LRU 缓存 + invalidate

## 4. IP 黑名单 Service

- [ ] 4.1 `noj-core/src/services/banlist.ts`：`listIpBans` / `addIpBan` / `removeIpBan` / `getBannedRanges`
- [ ] 4.2 CIDR 校验（拒绝 0.0.0.0/0）
- [ ] 4.3 重复 IP/CIDR 检测（查重抛 ConflictError）
- [ ] 4.4 审计日志：每次写操作 console.log `[admin] ...`

## 5. 用户封禁 Service

- [ ] 5.1 `noj-core/src/services/users.ts` 扩展：`banUser` / `unbanUser`
- [ ] 5.2 防自封禁 + 防封 root + 防封最后一个 admin（仿 promoteUser 模板）
- [ ] 5.3 `src/services/auth.ts` 的 `toUserResponse` 加 `banned` 字段
- [ ] 5.4 `src/services/auth.ts` 的 `listUsers` 加 `banned` 筛选
- [ ] 5.5 `src/types/auth.ts` 的 `UserResponse` + `SessionData` 加 `banned: boolean`

## 6. 中间件

- [ ] 6.1 `noj-core/src/middleware/banlist.ts`：IP 黑名单拦截
- [ ] 6.2 `noj-core/src/middleware/auth.ts` 扩展：banned 校验 + 60s LRU
- [ ] 6.3 `noj-core/src/middleware/auth.ts` 加 BAN_WHITELIST 常量
- [ ] 6.4 `noj-core/src/app.ts` 挂 `banlistMiddleware`（在 authMiddleware 之前）

## 7. 路由

- [ ] 7.1 `noj-core/src/routes/admin.ts`：`GET /blacklist`
- [ ] 7.2 `POST /blacklist`
- [ ] 7.3 `DELETE /blacklist/:id`
- [ ] 7.4 `PATCH /users/:id/ban`
- [ ] 7.5 `PATCH /users/:id/unban`

## 8. 后端测试

- [ ] 8.1 `noj-core/tests/services/banlist.test.ts`：CRUD + 重复检测 + 0.0.0.0/0 拒绝
- [ ] 8.2 `noj-core/tests/middleware/banlist.test.ts`：IP 命中拦截 / 未命中放行 / CIDR 匹配
- [ ] 8.3 `noj-core/tests/routes/admin-blacklist.test.ts`：5 端点（401/403/200/201/204/400/409）
- [ ] 8.4 `noj-core/tests/routes/admin-ban.test.ts`：ban / unban（自防 / 防 root / 防最后 admin）
- [ ] 8.5 改造 `noj-core/tests/routes/auth.test.ts`：banned 用户登录 403 + USER_BANNED

## 9. 前端

- [ ] 9.1 `noj-core/...` 编译/构建无错后，转 noj-ui
- [ ] 9.2 `noj-ui/composables/useAuth.ts`：`UserResponse` / `SessionData` 加 `banned: boolean`
- [ ] 9.3 `noj-ui/pages/login.vue`：支持 `?banned=1&reason=...&until=...` banner（红色）
- [ ] 9.4 `noj-ui/pages/admin/users.vue`：操作列加封禁/解封按钮 + banned 红色 badge
- [ ] 9.5 `noj-ui/layouts/admin.vue`：navItems 加 `{ label: '黑名单管理', to: '/admin/blacklist', icon: Ban }`
- [ ] 9.6 `noj-ui/pages/admin/blacklist.vue`：CRUD 三件套（仿 categories.vue）

## 10. 验证

- [ ] 10.1 `deno fmt --check` 通过
- [ ] 10.2 `deno lint` 通过
- [ ] 10.3 `deno test -A` 全量 343+ passed（新增 30+ 测试）
- [ ] 10.4 `noj-ui npm run build` 成功
- [ ] 10.5 端到端冒烟：curl 模拟 admin 加 IP 黑名单 + 验证拦截 + 封禁用户 + 登录 403

## 11. 提交 + PR

- [ ] 11.1 GPG 签名 commit（Conventional Commits + 中文）
- [ ] 11.2 `jj git push` 或 `git push --set-upstream` 到 `origin/feat/issue-102-ip-blacklist`
- [ ] 11.3 `gh pr create` 标题 `feat(core,ui): IP 黑名单 + 用户封禁（issue #102）`，body 含验收项 + reviewer's OpenSpec 引用
- [ ] 11.4 添加 reviewer（@box3-galen-nv）
