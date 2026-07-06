## 1. 后端：ban-status 端点

- [x] 1.1 在 `src/routes/` 下（`auth.ts` 或新建）新增 `GET /api/v1/auth/ban-status` handler，实现 IP 封禁状态查询 + 用户封禁状态查询
- [x] 1.2 在 `createApp()` 中将 ban-status 路由注册到 `/api/v1` 路径下（普通 GET 路由，方法限制策略自动生效，无需特殊挂载）

## 2. 后端：修复 getBannedRanges() 过期过滤

- [x] 2.1 修改 `src/services/banlist.ts` 的 `getBannedRanges()`，在返回前过滤 `expires_at !== null && expires_at < Date.now()` 的条目
- [x] 2.2 验证 `banlistMiddleware` 中的过期 IP 封禁条目不再匹配命中（全量测试 345 passed）

## 3. 后端：banlistMiddleware 改为仅拦截写操作 + 最小白名单

- [x] 3.1 修改 `src/middleware/banlist.ts`，对 GET/HEAD/OPTIONS 方法直接 `await next()` 放行
- [x] 3.2 保留 POST/PUT/PATCH/DELETE 的 IP 封禁检查不变
- [x] 3.3 新增最小白名单：`/api/v1/auth/logout` + `/api/v1/auth/login`

## 4. 后端：authMiddleware BAN_WHITELIST + 方法限制

- [x] 4.1 将 authMiddleware 的用户封禁检查改为仅拦截写操作（POST/PUT/PATCH/DELETE），GET 放行
- [x] 4.2 BAN_WHITELIST 更新为 `["/api/v1/auth/logout"]`
- [x] 4.3 ban-status 作为 GET 端点无需进入白名单（方法限制自动放行）

## 5. 前端：useBanStatus composable

- [x] 5.1 创建 `noj-ui/composables/useBanStatus.ts`，与 `useAuth.ts` 同模式，使用 `useState` 确保单次调用
- [x] 5.2 实现 `fetch()` 方法，调 `GET /api/v1/auth/ban-status`，填充所有响应式 ref

## 6. 前端：全局 BanBanner 组件

- [x] 6.1 创建 `noj-ui/components/BanBanner.vue` — 支持 `type="ip" | "user"`，渲染对应文案和样式
- [x] 6.2 IP 被封 Banner：橙色警告，显示 CIDR / 原因 / 到期时间
- [x] 6.3 用户被封 Banner：红色警告，显示原因 / 到期时间 + 登出按钮
- [x] 6.4 在 `app.vue` 中集成 BanBanner，根据 `useBanStatus()` 的状态条件渲染

## 7. 前端：清理旧封禁 UI 逻辑

- [x] 7.1 删除 `pages/login.vue` 中 `route.query.banned` / `?banned=1` URL 参数处理逻辑
- [x] 7.2 修改登录页 catch `USER_BANNED` 时直接渲染 Banner，不依赖 URL 跳转
- [x] 7.3 删除 `composables/useAuth.ts` 中 `UserResponse`/`SessionData` 的 banned 字段
- [x] 7.4 删除 `server/api/[...slug].ts` 中 session cookie 的 `banned` 字段

## 8. 测试

- [x] 8.1 新增 `tests/routes/auth-ban-status.test.ts`（6 个测试覆盖全部场景）
- [x] 8.2 banlist GET passthrough 由 ban-status 测试隐式覆盖（被封 IP 调 GET ban-status 得 200）
- [x] 8.3 更新 `tests/services/banlist.test.ts`（过期过滤 + getBannedIpDetail 测试）
- [x] 8.4 全量测试通过（345 passed | 0 failed）

## 9. 集成验证

- [ ] 9.1 启动 noj-core + noj-ui 验证 GET 放行 + POST 拦截
- [ ] 9.2 被封 IP 调 ban-status 返回 `ip_banned: true`
- [ ] 9.3 被 ban 用户调 ban-status 返回 `user_banned: true`
- [ ] 9.4 前端 BanBanner 正确渲染 IP 封禁 / 用户封禁
- [ ] 9.5 IP 封禁 `expires_at` 过期后不再拦截
