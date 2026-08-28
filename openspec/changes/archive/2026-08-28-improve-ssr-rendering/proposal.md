## Why

noj-ui 虽然开启了 Nuxt SSR，但数据获取、认证、SEO、缓存和错误处理并没有围绕 SSR 形成统一策略：社区等页面使用顶层 `await` + 普通 `ref` 导致服务端请求结果不序列化、客户端重复请求；社区配置接口失败时整个页面 SSR 直接 502；受保护页面在服务端先渲染空壳/错误态再被客户端重定向；首页、公告、竞赛详情等公开内容页几乎全部依赖客户端拉取；同时缺少 SEO 元信息、公开接口缓存和自定义错误页。

## What Changes

- 统一 SSR 数据获取策略：页面初始数据一律使用 `useAsyncData`/`useFetch`，`useApi` 仅用于交互、轮询和表单提交。
- 消除社区 5 个页面的顶层 `await` + 普通 `ref` 反模式，改为 SSR 可序列化数据获取或明确 `ssr: false`。
- 调整 `ssr: false` 边界：私信、我的题目、设置、队列、竞赛排名等纯交互页统一关闭 SSR；保留 admin/编辑器/新建编辑题目的关闭策略；竞赛详情从 `server: false` 改为真正 SSR 或明确 `ssr: false`。
- 强化 SSR 认证语义：受保护页面不再“先渲染再跳转”，服务端对登录态做真实校验，社区权限不再依赖客户端二次刷新补丁。
- 修复 `useApi` 在异步函数内调用 `useRequestHeaders` 的脆弱点，统一服务端 Cookie/Header 转发机制。
- 补齐 SEO：动态内容页增加 `useSeoMeta`/OG/canonical，增加 sitemap 与 robots。
- 为公开 SSR 数据增加缓存策略（路由级 SWR/ISR），排除认证接口。
- 增加自定义错误页，并让非关键数据（社区配置、首页公告等）在 SSR 失败时降级为空态/占位而非拖垮整页。
- 迁移 `pages/problems/[id].vue` 中残留的直接 `$fetch` 到 `useApi`。

## Capabilities

### New Capabilities

- `ssr-rendering`: 定义 noj-ui SSR 渲染与数据获取的统一行为，包括页面初始数据获取方式、顶层 await 约束、`ssr:false` 边界、SSR 错误降级。
- `ssr-seo`: 定义动态内容页的 SEO 元信息、Open Graph、canonical、sitemap 与 robots 行为。
- `ssr-caching`: 定义公开 SSR 数据的缓存策略与认证接口排除规则。

### Modified Capabilities

- `cookie-auth`: 修改 SSR 阶段认证状态的处理语义——服务端 SHALL 基于真实 token 校验/获取用户状态，而不是仅信任可读 session cookie；受保护页面不得在服务端渲染未验证的登录态。
- `ui-api-layer`: 补充 SSR 下的统一数据获取要求——SSR 请求 Cookie 转发统一、页面初始数据不绕过 `useApi`/`useFetch`，并清理残留直接 `$fetch`。
- `community-ui`: 社区相关页面（首页、帖子详情、收藏、通知、举报）的数据加载 SHALL 采用 SSR 可序列化方式或明确客户端渲染，不得使用顶层 `await` + 普通 `ref`。

## Impact

- 代码范围：`noj-ui/pages`、`noj-ui/composables`、`noj-ui/middleware`、`noj-ui/server`、`noj-ui/nuxt.config.ts`、`noj-ui/package.json`、`noj-ui/public`。
- 部署范围：`deploy/nginx/default.conf` 可能涉及缓存头调整。
- 无 noj-core API 变更，无数据库 schema 变更；均为 noj-ui 前端行为改造。
