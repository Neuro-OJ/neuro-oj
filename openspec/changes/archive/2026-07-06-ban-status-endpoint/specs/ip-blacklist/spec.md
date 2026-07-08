## MODIFIED Requirements

### Requirement: 运行时 IP 黑名单拦截

`noj-core` SHALL 在 `authMiddleware` 之前挂载 `banlistMiddleware`，对每个**写操作**请求执行：

1. 调用 `getClientIp(c)` 解析客户端 IP（沿用 `rateLimitEnv.ts:53`）
2. 从 `ip_bans` 表查询所有**未过期**条目（内存中过滤 `expires_at`，`expires_at === null || expires_at > Date.now()`）
3. 用 `isBannedIp(clientIp, ranges)` 匹配（CIDR + 裸 IP 范围）
4. 命中 → `throw new ForbiddenError("IP 已被加入黑名单", "IP_BLACKLISTED", { client_ip })`

`isBannedIp` SHALL 支持 IPv4 裸 IP（`1.2.3.4`）与 IPv4 CIDR（`10.0.0.0/8`）。IPv6 不在本版本支持范围。

中间件 SHALL 60s TTL LRU 缓存 `ip_bans` 列表，避免每请求查 DB（与 system-settings 同模式）。

**写操作定义**：POST、PUT、PATCH、DELETE 方法被拦截。GET、HEAD、OPTIONS 请求 SHALL 直接 `await next()` 放行。

**白名单**（写操作中需要豁免的路径）：

- `/api/v1/auth/logout` — IP 被封用户仍可登出
- `/api/v1/auth/login` — IP 被封用户可提交密码（`loginUser` 的 IP 封禁检查负责拦截）

**`getBannedRanges()` SHALL** 在返回前过滤掉 `expires_at < Date.now()` 的条目。

#### Scenario: 裸 IP 命中拦截

- **WHEN** `ip_bans` 表存在 `ip_or_cidr='1.2.3.4'` 且未过期
- **AND** 客户端 `X-Forwarded-For: 1.2.3.4`
- **AND** 请求方法为 POST
- **THEN** 响应 403 + `{"error": "IP 已被加入黑名单", "code": "IP_BLACKLISTED"}`

#### Scenario: CIDR 范围匹配

- **WHEN** `ip_bans` 表存在 `ip_or_cidr='10.0.0.0/8'`
- **AND** 客户端 `X-Forwarded-For: 10.5.3.7`
- **AND** 请求方法为 PATCH
- **THEN** 响应 403 + IP_BLACKLISTED

#### Scenario: GET 请求被放行

- **WHEN** `ip_bans` 表存在 `ip_or_cidr='1.2.3.4'` 且未过期
- **AND** 客户端 IP 为 1.2.3.4
- **AND** 请求方法为 GET
- **THEN** 不抛错，正常路由（包括 `/api/v1/auth/logout`、`/api/v1/auth/ban-status` 等）

#### Scenario: 过期条目自动忽略（中间件侧）

- **WHEN** `ip_bans` 表存在 `ip_or_cidr='1.2.3.4'` 且 `expires_at < Date.now()`
- **AND** 客户端 IP 为 1.2.3.4
- **AND** 请求方法为 POST
- **THEN** `getBannedRanges()` 不包含该条目，不抛错，正常路由

#### Scenario: 未命中放行

- **WHEN** `ip_bans` 表为空
- **AND** 任何客户端 IP
- **THEN** 不抛错，正常路由

#### Scenario: 60s 缓存失效（写操作）

- **WHEN** admin 新增 IP 黑名单条目
- **AND** 30 秒内客户端命中 IP 发送 POST 请求
- **THEN** 立即 403（因为 `invalidateBanCache(ip_or_cidr)` 触发缓存失效）
