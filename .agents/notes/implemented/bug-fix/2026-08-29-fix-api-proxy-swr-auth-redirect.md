# Agent Note: 修复我的题目页因 API 代理缓存异常误退登

Status: implemented

## Problem

`noj-ui` 的通用 API 代理路由配置了 Nitro SWR。代理会直接返回上游响应对象，其中包含无法被缓存存储序列化的对象；同时 `/api/v1/problems` 等路径混合了公开与按用户鉴权的接口。进入“我的题目”时，请求可能挂起或复用错误响应，前端统一 401 处理随后清除登录 Cookie 并跳转登录页。

## Decision

移除通用 API 代理上的 SWR 路由规则，并保留明确的 `no-store` 鉴权接口规则。新增配置回归测试，防止未来再次给通用代理配置 SWR。需要缓存时，应在明确的、非个性化 server handler 中单独实现。

## Alternatives considered

- 仅关闭 `useApi` 的 401 登录跳转：只能掩盖错误响应，不能修复代理挂起和错误缓存，也会削弱真实会话失效的处理。
- 只移除 `/api/v1/problems` 的 SWR：可以覆盖当前页面，但 `/api/v1/tags` 同样经过不可缓存的通用代理；保留其他代理 SWR 仍会复现同类问题。
- 重写通用代理为可序列化的 Web `Response`：改动面更大，可能影响请求体、响应头和 SSE 转发；当前需求不需要承担该风险。

## Consequences

通用 API 代理不再享受 Nitro 层 SWR，公开接口的缓存收益被让渡给正确性、鉴权隔离和 Deno 运行时兼容性。缓存需求需要在具体的安全边界内重新设计。登录后从头像菜单进入“我的题目”可正常加载，登录 Cookie 不会因代理缓存异常被清除。
