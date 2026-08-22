## Purpose

定义 noj-core 面向浏览器客户端的跨域凭证请求行为，以及限流和请求追踪响应头的可读取性，避免开发环境认证失败和客户端无法获取重试信息。

## Requirements

### Requirement: 浏览器凭证 CORS

noj-core SHALL 为需要 Cookie 或其他凭证的跨域请求返回与请求来源匹配的 `Access-Control-Allow-Origin`，并返回 `Access-Control-Allow-Credentials: true`。开发环境 SHALL 使用受控的本地来源配置，不得组合 `Access-Control-Allow-Origin: *` 与凭证允许标记；生产环境 SHALL 继续仅允许配置的来源白名单。

#### Scenario: 开发环境本地 UI 跨域请求

- **WHEN** 开发环境的本地 UI 从允许的 localhost/127.0.0.1 来源发起带凭证请求
- **THEN** noj-core 返回该请求来源而不是 `*`，并允许凭证，浏览器可以完成请求

#### Scenario: 生产环境拒绝未配置来源

- **WHEN** 生产环境请求来源不在 `CORS_ALLOWED_ORIGINS` 白名单中
- **THEN** noj-core 不授权该来源的跨域访问

### Requirement: CORS 暴露限流与追踪响应头

对于已返回的限流和请求追踪响应头，noj-core SHALL 通过 CORS `Access-Control-Expose-Headers` 暴露 `Retry-After`、`X-RateLimit-Limit`、`X-RateLimit-Remaining`、`X-RateLimit-Reset` 和 `X-Request-Id`，使浏览器 Fetch/XHR 客户端可以读取这些值。

#### Scenario: 浏览器读取限流信息

- **WHEN** 跨域请求触发限流并返回 `Retry-After` 或 `X-RateLimit-*` 响应头
- **THEN** 浏览器客户端可以通过 Fetch/XHR 读取这些响应头

#### Scenario: 浏览器读取请求 ID

- **WHEN** 跨域请求返回 `X-Request-Id`
- **THEN** 浏览器客户端可以读取该请求 ID 并用于问题追踪
