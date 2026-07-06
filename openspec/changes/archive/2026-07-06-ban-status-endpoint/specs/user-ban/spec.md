## MODIFIED Requirements

### Requirement: 用户封禁状态校验

`noj-core` SHALL 在 `authMiddleware` 中（`c.set("userId", ...)` 之后、`await next()` 之前）查询 `users.banned / banned_reason / banned_until`，命中则抛 `ForbiddenError("账号已被封禁", "USER_BANNED", { reason, until })`。

校验 SHALL 遵循 Decision 1 的"方法限制 + 最小白名单"策略：

- GET/HEAD/OPTIONS 请求 → 直接放行（被封用户仍可浏览、查 ban-status）
- POST/PUT/PATCH/DELETE 请求 → 检查封禁状态，命中抛 403

白名单（仅对写操作豁免）：

- `/api/v1/auth/logout` — 被封用户永远可登出
- `/api/v1/auth/login` — 被封用户可提交密码，由 `loginUser` service 返 403 + USER_BANNED

校验 SHALL 60s TTL LRU 缓存 `userId → BanState`。`banUser` / `unbanUser` 写入时调用 `invalidateBanCache(userId)` 立即失效。

**注意**：`/api/v1/auth/ban-status` 是 GET 端点，方法限制自动放行，无需进入白名单。`/me` 和 `/login` 同理（GET 放行 / login 由 `loginUser` service 层独立检查）。

#### Scenario: 已封禁用户写操作 403

- **WHEN** 用户已被 ban（`users.banned = true`，未过期）
- **AND** 携带有效 JWT 调用 POST/PATCH 等写操作端点
- **THEN** 响应 403 + `{"error": "账号已被封禁", "code": "USER_BANNED", "reason": "...", "until": "..."}`

#### Scenario: 已封禁用户 GET 请求放行

- **WHEN** 用户已被 ban（`users.banned = true`，未过期）
- **AND** 携带有效 JWT 调用 GET 端点（如 `/api/v1/problems`）
- **THEN** 正常路由，不抛错

#### Scenario: 临时封禁到期后自动放行

- **WHEN** 用户 `banned=true` 但 `banned_until < now`
- **AND** 携带有效 JWT 访问
- **THEN** 不抛错，正常路由

#### Scenario: banned 用户仍可查 ban-status

- **WHEN** 用户已被 ban
- **AND** `GET /api/v1/auth/ban-status`
- **THEN** 响应 200，body 含 `user_banned: true, user_ban_info: { reason, until }`

#### Scenario: banned 用户仍可登出

- **WHEN** 用户已被 ban
- **AND** `POST /api/v1/auth/logout`
- **THEN** 正常调用，不抛错

#### Scenario: 60s 缓存失效

- **WHEN** admin 调用 `PATCH /api/v1/admin/users/:id/unban` 成功
- **AND** 该用户立即（< 60s）携带旧 JWT 调用写操作端点
- **THEN** 正常路由（200），不返 403

### Requirement: 登录页 banned 拦截

`noj-ui/pages/login.vue` SHALL 在以下情况下渲染封禁 Banner：

1. `POST /api/v1/auth/login` 返回 403 + `USER_BANNED` — 登录页捕获后直接渲染（不依赖 URL 参数）
2. 从 ban-status 端点获取的 `user_banned: true` 状态通过全局 BanBanner 展示，不依赖路由跳转到登录页

登录页 SHALL **不再**支持 `?banned=1&reason=...&until=...` URL 参数传递——改为：
- 被封用户输入密码后，服务端 `loginUser` 抛 403 + `USER_BANNED`，前端 `$fetch` catch 到错误码后在登录页渲染红色 Banner
- 已登录用户被封由全局 BanBanner 接管（不跳转到登录页）
- IP 被封用户即使未登录也由全局 BanBanner 展示

登录页 Banner 显示规则：
- 永久 ban："账号已被封禁。{reason}。请联系管理员。"
- 临时 ban："账号已被封禁至 {until}。{reason}。请联系管理员。"

#### Scenario: 被封用户输入密码后显示 banner

- **WHEN** 用户被永久 ban 调用 `POST /api/v1/auth/login`
- **AND** 密码正确（服务端 `loginUser` 在密码校验后检测到 ban 状态）
- **THEN** 响应 403 + `{"code": "USER_BANNED", "reason": "spam"}`，登录页渲染红色 banner

#### Scenario: 解封后登录成功

- **WHEN** 用户已被解封（`banned=false`）调用 `POST /api/v1/auth/login`
- **THEN** 响应 200 + token，正常登录

## REMOVED Requirements

### Requirement: 登录页 `?banned=1` URL 参数

**Reason**: 封禁状态告知改为 ban-status 端点 + 全局 BanBanner 方案。URL 参数传递方式存在多个问题：被封 IP 用户的路由重定向可能失败；URL 中的封禁信息可被手动清除绕过；逻辑散落在三个文件间难以维护。

**Migration**: 前端删除 `login.vue` 中的 `route.query.banned` 检查逻辑。服务端不再在 `loginUser` 中 response 的 `meta` 依赖前端 URL 跳转——改为前端直接在登录页 catch 到 403 后渲染。全局 BanBanner 接管已登录用户的封禁提示。
