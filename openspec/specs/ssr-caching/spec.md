## Purpose

定义 noj-ui 公开 SSR 接口缓存与认证/个性化接口不缓存的规范，降低 noj-core 压力并提升 SSR 响应速度。

## Requirements

### Requirement: 公开 SSR 接口启用缓存

系统的公开、无用户上下文 GET 接口 SHALL 配置缓存（Nitro `routeRules` 的 `swr`/`isr`，或代理响应 `Cache-Control: s-maxage`），以降低 noj-core 压力并提升 SSR 响应速度。

#### Scenario: 公开题目列表被缓存

- **WHEN** 多个客户端请求 `/api/v1/problems` 且参数相同
- **THEN** 后续请求可命中缓存或 SWR 缓存，不每次都回源 noj-core

#### Scenario: 公开榜单被缓存

- **WHEN** 客户端请求 `/api/v1/rankings`
- **THEN** 响应可被缓存，缓存失效后重新回源

### Requirement: 认证与个性化接口不缓存

涉及登录态、用户权限、私密数据或实时状态的接口 SHALL NOT 被公共缓存，包括 `/api/v1/auth/*`、`/api/v1/submissions`、`/api/v1/queue` 以及社区中依赖权限的端点。

#### Scenario: 认证接口不被缓存

- **WHEN** 客户端请求登录或当前用户接口
- **THEN** 响应设置 `Cache-Control: no-store` 或不进入公共缓存

#### Scenario: 提交记录不被缓存

- **WHEN** 客户端请求个人提交记录
- **THEN** 响应不被公共缓存，避免泄露或串数据

### Requirement: 缓存失效与回源

缓存配置 SHALL 提供合理的过期时间或再验证机制，并保证源站不可用时仍能通过缓存/降级响应服务公开数据。

#### Scenario: 缓存过期后回源

- **WHEN** 公开接口缓存超过 TTL
- **THEN** 下一次请求回源 noj-core 获取最新数据并刷新缓存
