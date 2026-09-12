# Agent Note: 修复 OAuth 302 被代理跟随与 sitemap 缓存投毒

Status: implemented

## Problem

两处 noj-ui 缺陷：

1. **OAuth 登录不可用（潜伏）**：非 SSE 分支 `await proxyRequest(event, target)` 未传 `fetchOptions`。h3 的 `sendProxy` 用 ofetch 且不设 `redirect` 默认值 → 平台默认 `follow`；上游 302（OAuth 授权跳转）被代理自己跟随，把第三方页面回吐给浏览器，用户永远停在 `/api/v1/auth/oauth/:provider`，进不到回调端点（state 校验与 `Set-Cookie` 都在回调响应里）。SSE 分支此前已显式设了 `redirect: 'manual'`，作者知道该语义但只覆盖了 SSE。
2. **sitemap 缓存投毒**：`origin` 派生自**请求 Host 头**却写入**进程级**缓存（TTL 1h）。伪造一次 `Host: evil.com` 即可把 `<loc>https://evil.com/...</loc>` 钉住一小时，影响所有访客与搜索引擎；此外降级结果（core 不可达）同样被缓存，且没有 `Cache-Control`。

## Decision

1. 非 SSE 分支补 `proxyRequest(event, target, { fetchOptions: { redirect: 'manual' } })`，并在注释中记录失效链路；新增**源码级回归测试** `tests/apiProxyRedirect_test.ts`：遍历所有 `proxyRequest(` 调用点，要求附近显式声明 `redirect: 'manual'`——将来新增透传点忘带该语义会失败。
2. sitemap：新增 `NUXT_SITE_URL` 权威地址（`runtimeConfig.siteUrl`）优先；未配置时回退到**形状校验过的** Host 且缓存**按 origin 分键**（投毒只能污染伪造者自己的键）；Host 非法直接 400；降级结果不写缓存（有旧缓存则返回旧缓存）；显式 `cache-control`。origin 解析抽到 `server/utils/sitemap-origin.ts` 以便测试。

## Alternatives considered

- 只加 `redirect: 'manual'` 不写测试：这类"代理语义"缺陷是成片出现的（历史上已修过状态码版本），需要回归网。
- sitemap 只做 Host 白名单：多域名部署会误伤，且白名单本身要维护；权威配置 + 分键缓存更稳。
- 让降级结果也缓存：会把"只有首页"的残缺 sitemap 固化一小时。

## Consequences

OAuth 一旦启用即可用；sitemap 不再可被 Host 头投毒。`tests/sitemapOrigin_test.ts` 覆盖配置优先、非法 Host 拒绝、按 origin 分键（含降级分支不写缓存的源码级断言）。生产必须配置 `NUXT_SITE_URL`（已写入 `.env.prod.example` 与模块文档）。
