# Agent Note: HTTP 安全响应头统一策略

Status: implemented

## Problem

生产容器 Nginx 已有基础安全头和强制 CSP，但 core API 与 Nitro 直连部署路径没有一致的基础头；应用层也没有 CSP Report-Only 观察入口。HSTS 若由应用或容器 HTTP Nginx 设置，会把 TLS 终止职责错误地下沉。

## Decision

- noj-core 直连响应统一设置 `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy` 和受限 `Permissions-Policy`。
- Nitro 直连页面/API 设置上述基础头、保留兼容性的强制 CSP，并增加更窄的 CSP Report-Only 策略。
- Nitro 的 `/api/csp-report` 只接受三种 JSON 媒体类型、限制 16 KiB 请求体、拒绝非对象 JSON，并以 204 响应且不落盘。
- 容器 Nginx 保留原强制 CSP，增加相同 Report-Only 策略；通过 `proxy_hide_header` 隐藏上游同名头，避免重复 CSP 合并。
- HSTS 仅由真正终止 TLS 的外部边缘配置，应用与容器 Nginx 均不发送。

## Alternatives considered

- 仅修改 Nginx：无法覆盖绕过仓库 Nginx 的 core/Nitro 直连路径。
- 立即移除 `unsafe-inline`/`unsafe-eval`：Nuxt 水合和 Monaco 可能静默失效，先用 Report-Only 收集真实违规更稳妥。
- 在应用和 Nginx 同时追加 CSP：浏览器会合并多条策略，容易产生未预期阻断，因此由当前部署路径的 Nginx 统一输出。

## Consequences

应用直连与容器部署都具备可回归的安全头；Report-Only 报告暂不持久化，后续需根据实际报告迁移到 nonce/hash 或自托管资源并收紧强制 CSP。外部 TLS 边缘仍必须显式配置 HSTS。
