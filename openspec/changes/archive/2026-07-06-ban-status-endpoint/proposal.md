## Why

PR #108 (`admin-ip-blacklist`) 实现了 IP 黑名单和用户封禁的后端拦截能力，但存在三个用户体验死锁：1) IP 被封用户所有 API 请求全被 `banlistMiddleware` 拦截，连登出都做不到；2) 用户被封后错误信息通过 URL 参数传递，前端逻辑散落各处；3) `ip_bans.expires_at` 字段写入后从未被读取，过期条目仍然生效。本变更引入一个不受中间件限制的 `ban-status` 端点，统一"告知状态"与"阻止操作"两条逻辑线。

## What Changes

- **新增** `GET /api/v1/auth/ban-status` 端点 — 返回调用者 IP 封禁状态 +（有 JWT 时）用户封禁状态，不经过 `banlistMiddleware` 和 `authMiddleware` 封禁检查
- **修改** `banlistMiddleware` — 只拦截写操作（POST/PUT/PATCH/DELETE），GET 请求放行，让被封 IP 的用户仍可浏览页面并查看自己的 ban 状态
- **修复** `getBannedRanges()` — 正确过滤 `expires_at`，过期 IP 封禁条目不再匹配命中
- **新增** 前端 `useBanStatus.ts` composable — 应用启动时调 ban-status，暴露响应式全局封禁状态
- **新增** 前端全局封禁 Banner 组件 — 根据 ban-status 结果渲染覆盖层（IP 被封 / 用户被封）
- **删除** 前端 `BAN_WHITELIST` — ban-status 端点本身不受限，不再需要白名单豁免
- **删除** 前端登录页 `?banned=1` URL 参数处理 — 由全局 Banner 统一接管

## Capabilities

### New Capabilities
- `ban-status-endpoint`: `GET /api/v1/auth/ban-status` 端点，不受中间件拦截，返回当前请求的 IP 封禁状态和（如已登录）用户封禁状态，为前端提供统一的封禁状态查询入口

### Modified Capabilities
- `ip-blacklist`: `banlistMiddleware` 从全拦截改为仅拦截写操作；`getBannedRanges()` 修复 `expires_at` 过滤
- `user-ban`: `authMiddleware` 移除 `BAN_WHITELIST`，封禁状态告知职责转移给 ban-status 端点
- `user-auth`: `authMiddleware` 保留封禁检查但白名单缩小（仅 ban-status + me + logout 放行，或直接移除白名单改为仅拦截写操作）

## Impact

- **noj-core**：
  - 新增 `src/routes/auth.ts` 中的 `GET /api/v1/auth/ban-status` handler
  - 修改 `src/middleware/banlist.ts`（改为仅拦截写操作）
  - 修改 `src/middleware/auth.ts`（调整/移除 BAN_WHITELIST）
  - 修改 `src/services/banlist.ts`（修复 `getBannedRanges()` 过期过滤）
  - 修改 `src/app.ts`（中间件注册顺序可能调整）
- **noj-ui**：
  - 新增 `composables/useBanStatus.ts`
  - 新增全局 BanBanner 组件（或在 `app.vue` / 布局中集成）
  - 修改 `pages/login.vue`（移除 `?banned=1` URL 参数处理）
  - 修改 `composables/useAuth.ts`（移除散落的 banned 字段传递逻辑）
- **兼容性**：ban-status 端点新增，不影响现有接口；中间件行为变更属于向后兼容（GET 放行不会引入安全风险）
- **性能**：ban-status 端点复用现有 60s LRU 缓存，每次请求一次内存查询
