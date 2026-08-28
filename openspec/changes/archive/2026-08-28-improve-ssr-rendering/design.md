## Context

noj-ui 使用 Nuxt 4 + Vue 3，Nitro 部署为 `deno-server`，SSR 默认开启。现状调查发现：

- 数据获取方式分裂：部分页面用 `useFetch`/`useAsyncData`，大量公开内容页（首页、公告、竞赛详情、社区）用 `onMounted`/顶层 `await` + `api.get`；
- 社区 5 个页面在 `<script setup>` 顶层 `await` 写普通 `ref`，服务端请求结果不会序列化到客户端，造成双倍请求和延迟水合；其中 `community/index` 与 `community/posts/[id]` 的 `loadConfig()` 未捕获，core 不可达时 SSR 直接 502；
- 认证在 SSR 端只信任可读 `noj:session`，中间件跳过服务端，受保护页先渲染再跳转；
- 无 SEO 元信息、无公开接口缓存、无自定义错误页。

本次改造全部在 noj-ui 前端完成，不改变 noj-core API 与数据库结构。

## Goals / Non-Goals

**Goals:**

- 建立统一的 SSR 数据获取规则：页面初始数据用 `useAsyncData`/`useFetch`，交互/轮询/表单用 `useApi`。
- 消除社区顶层 `await` + 普通 `ref` 反模式，修复 `community` 502 与双倍请求。
- 明确 `ssr:false` 边界：纯交互/强登录页关闭 SSR；内容/SEO 页保持 SSR。
- 让 SSR 阶段能基于真实 token 获取完整用户与权限，受保护页不再先渲染再跳转。
- 补齐动态内容页 SEO 与全站 sitemap/robots。
- 为公开接口增加可配置缓存，降低 core 压力。
- 增加自定义错误页和非关键数据降级，避免单接口故障拖垮整页。
- 统一服务端 Cookie/Header 转发，消除 `useApi` 在异步函数内调用 `useRequestHeaders` 的隐患。

**Non-Goals:**

- 不改变 noj-core 的 API 契约、鉴权逻辑、数据库 schema。
- 不做 SSR 到 CSR 的运行时切换框架改造（不引入实验性流式 SSR）。
- 不重构认证后端（不引入刷新令牌、不改变 Cookie 安全模型）。
- 不做完整的 SEO 关键词/内容策略，只补技术性元信息与可索引资产。

## Decisions

### 1. 数据获取统一：初始数据走 `useAsyncData`/`useFetch`

所有页面在 setup 阶段决定“初始数据”，使用 Nuxt 原生数据获取；`useApi` 保留给用户交互、轮询和表单提交。原因：Nuxt 会自动把 `useAsyncData`/`useFetch` 的 payload 序列化到客户端，避免双倍请求；`useApi` 不应承担初始渲染数据职责。

替代方案（否决）：继续用 `useApi` 并在顶层 `await`，然后用 `useState` 手动缓存。该方案需人工保证序列化，容易遗漏普通 ref，且仍可能触发无关请求。

### 2. 社区改造：公共列表/详情保持 SSR，登录相关子页面 `ssr:false`

- `community/index.vue`、`community/posts/[postId].vue` 是公开内容页，改为 `useAsyncData` 获取 config/posts/comments；`loadConfig` 必须 catch，失败时降级为空配置而不是抛错。
- `community/bookmarks.vue`、`notifications.vue`、`reports/[id].vue` 是强登录用户页，改为 `ssr:false`，移除顶层 await。
- 这样既保住社区的 SEO/首屏，又消除 502 和双倍请求。

替代方案（否决）：所有社区页统一 `ssr:false`。会失去社区列表/详情的 SSR/SEO 价值。

### 3. `ssr:false` 边界

保留 `ssr:false`：全部 admin、编辑器、新建/编辑题目、竞赛做题页。新增 `ssr:false`：`messages/index`、`my/problems`、`settings`、`queue`、`contests/[contestId]/ranking`（组件已 `server:false`）、`community/bookmarks`、`community/notifications`、`community/reports/[id]`。

`contests/[contestId]/index.vue` 移除 `server:false`，让竞赛详情公开信息参与 SSR；其中题目/排行等敏感或实时部分仍由组件客户端加载。

### 4. SSR 认证：以“真实 token 校验 + 强登录页关闭 SSR”混合策略

- `useAuth` 在 SSR 阶段若检测到 `noj:session`，通过 `useRequestFetch` 调 `/api/v1/auth/me` 获取完整 `UserResponse` 和 `permissions`，写入 `useState`，而不是只从 session cookie 映射。
- 路由中间件不再无条件 `if (import.meta.server) return`：服务端可基于已填充的 `auth:user` 做重定向；若认证请求失败，按未登录处理。
- 强交互/强登录页（私信、我的题目、设置、社区收藏/通知/举报）直接 `ssr:false`，由客户端守卫负责，避免服务端渲染无意义页面。

替代方案（否决）：所有受保护页都做服务端 `/auth/me`。会增加每个受保护页一次上游请求，且对纯交互页收益低；混合策略更符合页面性质。

### 5. 统一服务端请求：`useApi` 内部使用 `useRequestFetch`

`useApi` 在 SSR 分支用 `useRequestFetch()` 取代手动 `useRequestHeaders(['cookie'])`，与 `useFetch` 行为对齐；同时把 `useAdminList`、`useAuditLogs`、`useSearch` 等 composable 里的 `useApi()` 调用从 async 函数内部挪到 composable 同步 setup 顶部，消除 `NUXT_E1001` 隐患。

替代方案（否决）：继续手动转发 Cookie。与 `useFetch` 双轨不一致，且无法转发其他请求头。

### 6. SEO：动态页 `useSeoMeta` + Nitro sitemap

- 在 `problems/[id]`、`users/[id]`、`community/posts/[id]`、`submissions/[id]`、`announcements/[id]`、`contests/[contestId]/index` 等动态页增加 `useSeoMeta`（title/description/OG/canonical）。
- 新增 `server/routes/sitemap.xml.ts`：从 noj-core 拉取公开 problem/user/contest 公共标识，短 TTL 内存缓存后输出 XML。
- 新增 `public/robots.txt`：允许抓取公开路径，禁止 admin/editor/设置等。

替代方案（否决）：引入 `@nuxtjs/sitemap` 模块。在 Deno 单二进制 + 离线部署场景下增加构建与运行时不确定性；自建 Nitro 路由更可控。

### 7. 缓存：`routeRules` + 代理层显式 `Cache-Control`

- 在 `nuxt.config.ts` 增加针对公开 GET 接口的 `routeRules`，使用 `swr: true` / `isr` 语义（由 Nitro/部署层支持），覆盖 `/api/v1/problems`、`/api/v1/rankings`、`/api/v1/contests`、`/api/v1/trainings`、`/api/v1/announcements`、`/api/v1/tags`、`/api/v1/stats`。
- 认证接口（`/api/v1/auth/*`、`/api/v1/community/*` 中依赖权限的端点、`/api/v1/submissions`、`/api/v1/queue`）不进入缓存。
- 若 `routeRules` 在当前部署预设下不可用，则退化为在 Nitro 代理中对上述公开 GET 响应设置 `Cache-Control: s-maxage=...`，并在 nginx 关闭 `proxy_cache off` 的前提下由边缘/CDN 缓存。

替代方案（否决）：全站缓存。会缓存到用户个性化内容，风险高。

### 8. 错误处理：自定义错误页 + 非关键数据降级

- 新增 `error.vue`，对 404/500/网络错误提供中文友好页。
- `loadConfig` 等非关键引导数据改为 catch 后返回安全默认值；社区页面 `init` 不再因配置失败抛错。
- 对所有 SSR 首屏非关键数据，若失败则以空态渲染，不阻断页面。

## Risks / Trade-offs

- [服务端 `/auth/me` 会给每个带 session 的 SSR 请求增加一次上游请求] → 仅对需要 SSR 的公共/半公开页面启用；强登录页 `ssr:false` 不触发。
- [`routeRules` 缓存可能与用户个性化响应冲突] → 白名单仅限确定公开、无用户上下文的接口，并在设计中列出排除项。
- [社区从顶层 await 改为 `useAsyncData` 改动较多，可能触及现有 NOJ-317 补丁] → 改动时同步移除客户端强制刷新 config 的 workaround，以服务端完整权限为准。
- [`useApi` 迁移 `useRequestFetch` 可能影响 SSR Cookie 传递行为] → 通过现有 E2E 与 curl 验证登录态 API；若出现回归，保留手动 Cookie 分支作为 fallback。
- [SEO 动态 meta 依赖数据加载，SSR 失败时 meta 可能不完整] → 使用 `useSeoMeta` 头部的可计算值，并用默认描述兜底。

## Migration Plan

1. 先新增/修改 spec 与 tasks；实现按 tasks 顺序推进。
2. 实现顺序建议：
   - 修 `useApi` 统一转发 + 修 `loadConfig` 降级（低风险、先止血 502）；
   - 迁移社区页面到 `useAsyncData` / `ssr:false`；
   - 调整 `ssr:false` 边界与 `contests` 详情 SSR；
   - SSR 认证增强；
   - SEO、缓存、错误页。
3. 每步跑 `deno task check` 与 `deno task build`，并用启动产物 curl 验证。
4. 回滚策略：每个决策点独立可回滚；若 `routeRules` 缓存引发问题，删除对应路由规则即可；若 SSR 认证引发性能问题，可回退为“session cookie 映射 + 客户端刷新”。

## Open Questions

- 当前部署的 Nitro `deno-server` 预设是否完整支持 `routeRules` 的 `swr`？若不支持，采用代理层 `Cache-Control` 方案。
- 是否需要在 sitemap 中包含用户主页？用户主页是否允许被搜索引擎收录需产品确认；默认先包含题目与竞赛，用户主页待定。
