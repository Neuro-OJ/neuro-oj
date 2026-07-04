## ADDED Requirements

### Requirement: ban-status 端点

系统 SHALL 提供 `GET /api/v1/auth/ban-status` 端点，该端点**不受 `banlistMiddleware` 和 `authMiddleware` 封禁检查拦截**，始终返回当前请求的封禁状态。

端点 SHALL 返回以下 JSON 结构：

```json
{
  "ip_banned": true | false,
  "ip_ban_info": {
    "matched_cidr": "1.2.3.4",
    "reason": "...",
    "expires_at": null
  } | null,
  "user_banned": true | false,
  "user_ban_info": {
    "reason": "...",
    "until": "2026-07-15T00:00:00.000Z"
  } | null,
  "authenticated": true | false,
  "user": { "id": "...", "username": "...", "role": "..." } | null
}
```

- `ip_banned` SHALL 为 `true` 当且仅当请求客户端 IP 命中 `ip_bans` 表的**未过期**条目
- `ip_ban_info` SHALL 包含匹配到的 CIDR/原因/过期时间（`null` = 未命中）
- `user_banned` SHALL 为 `true` 当且仅当存在有效 JWT 且对应用户 `banned=true` 且 `banned_until` 未过期
- `authenticated` SHALL 指示请求是否携带有效 JWT
- `user` SHALL 为已认证用户的基本信息（同 `/me` 子集）

IP 封禁过期判定 SHALL 使用 `expires_at === null（永久）|| expires_at > Date.now()`。

#### Scenario: 未登录用户 IP 被封，调用 ban-status

- **WHEN** 客户端 IP 在 `ip_bans` 黑名单中且未过期
- **AND** 请求不携带 JWT
- **THEN** 响应 200，`ip_banned: true`，`user_banned: false`，`authenticated: false`

#### Scenario: 已登录用户 IP 未被封、用户被封，调用 ban-status

- **WHEN** 已登录用户被封禁（`banned=true` 且 `banned_until` 未过期）
- **AND** 客户端 IP 未被封
- **THEN** 响应 200，`ip_banned: false`，`user_banned: true`，`authenticated: true`

#### Scenario: IP 封禁已过期，调用 ban-status

- **WHEN** `ip_bans` 条目 `expires_at < Date.now()`
- **AND** 客户端 IP 匹配该条目
- **THEN** 响应 200，`ip_banned: false`（过期条目不视为封禁）

#### Scenario: 用户临时封禁已过期，调用 ban-status

- **WHEN** `users` 行 `banned=true` 但 `banned_until < Date.now()`
- **AND** 该用户携带有效 JWT 调用 ban-status
- **THEN** 响应 200，`user_banned: false`

#### Scenario: ban-status 端点不被 banlistMiddleware 拦截

- **WHEN** 客户端 IP 在黑名单中
- **AND** 请求 `GET /api/v1/auth/ban-status`
- **THEN** 响应 200（不返回 403 IP_BLACKLISTED）

### Requirement: 前端全局封禁状态查询与展示

`noj-ui` SHALL 提供 `useBanStatus` composable，在应用首次加载时调用 `GET /api/v1/auth/ban-status` 获取封禁状态，并通过响应式 ref 暴露给组件。

`noj-ui` SHALL 在布局级（`app.vue` 或 `layouts/default.vue`）渲染全局封禁 Banner：

- IP 被封：全宽红色/橙色 Banner，显示"您的 IP（{matched_cidr}）已被限制访问。原因：{reason}。如认为这是误判请联系管理员。"
- 用户被封：全宽红色 Banner，显示"账号已被封禁{直至 {until}}。原因：{reason}。请联系管理员。"
- 严重程度：IP 被封且 blocking 时隐藏主要内容，仅显示 Banner + 登出按钮

Banner 的显示 SHALL 不依赖路由跳转——在 ban-status 调用完成后的首次渲染就展示。

#### Scenario: IP 被封用户看到全局提示

- **WHEN** 用户（登录或未登录）访问 noj-ui，调 ban-status 返回 `ip_banned: true`
- **THEN** 页面顶部渲染 IP 封禁 Banner，下方正常内容被覆盖层灰化

#### Scenario: 用户被封用户看到全局提示并留有登出入口

- **WHEN** 已登录用户调 ban-status 返回 `user_banned: true`
- **THEN** 页面顶部渲染用户封禁 Banner，Banner 右侧包含"登出"按钮

#### Scenario: 无封禁时 Banner 不显示

- **WHEN** ban-status 返回 `ip_banned: false` 且 `user_banned: false`
- **THEN** 不渲染任何 BanBanner，页面正常

### Requirement: useBanStatus composable

`noj-ui` SHALL 提供 `composables/useBanStatus.ts`，导出：

```typescript
function useBanStatus(): {
  ipBanned: Ref<boolean>
  userBanned: Ref<boolean>
  ipBanInfo: Ref<{ matched_cidr: string; reason: string; expires_at: string | null } | null>
  userBanInfo: Ref<{ reason: string; until: string | null } | null>
  authenticated: Ref<boolean>
  user: Ref<{ id: string; username: string; role: string } | null>
  loading: Ref<boolean>
  error: Ref<string>
  fetch: () => Promise<void>
}
```

`fetch()` SHALL 调用 `$fetch("/api/v1/auth/ban-status")` 并填充所有 ref。

composable SHALL 使用 `useState` 确保 `fetch()` 在 SSR 到客户端水合过程只调一次（与 `useAuth` 模式一致）。

#### Scenario: 应用启动时自动获取

- **WHEN** noj-ui 首次加载（客户端水合后）
- **THEN** `useBanStatus().fetch()` 被调用，封禁状态可通过 ref 读取

#### Scenario: 封禁后用户手动刷新页面

- **WHEN** 用户调用 `fetch()` 重新获取 ban-status
- **THEN** 所有 ref 更新为最新值
