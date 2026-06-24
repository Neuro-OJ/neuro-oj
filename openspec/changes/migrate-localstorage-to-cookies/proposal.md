## Why

当前 Neuro OJ 前端（noj-ui）使用 `localStorage` 存储 JWT token，导致两个核心问题：

1. **无法 SSR（服务端渲染）**：`localStorage` 在服务端不可用，多个页面被迫使用 `ssr: false`，丧失了 SSR 带来的首屏加载速度和 SEO 优势
2. **XSS 攻击面大**：`localStorage` 中的 token 可被任意 JavaScript 读取，一旦 XSS 漏洞出现，token 即泄露

迁移到 Cookie（特别是 HTTP-only Cookie）后，Token 对 JavaScript 不可见，同时 Cookie 天然跟随请求发送到服务端，使 SSR 时的身份认证成为可能。

## What Changes

- **Token 存储方式变更**：从 `localStorage.getItem/setItem/removeItem("noj:token")` 迁移到 Nuxt `useCookie` 和 HTTP-only Cookie 的组合方案
- **Nitro 服务端代理增强**：`server/api/[...slug].ts` 在收到请求时，自动读取 HTTP-only Cookie 中的 token，并注入 `Authorization: Bearer` 头转发给 noj-core；在登录接口返回时，拦截 token 并设置 HTTP-only Cookie
- **`useAuth` composable 重写**：移除所有 `localStorage` 调用，改为 SSR 友好的 Cookie/响应式状态管理
- **SSR 逐页评估**：分析每个页面的数据请求模式（useFetch/useAsyncData/$fetch），根据实际需求决定 SSR 开启或保留现状：
  - `pages/settings.vue`：移除 `definePageMeta({ ssr: false })`——个人设置页，auth 状态 SSR 就绪后避免白屏闪烁
  - `pages/submissions/[id].vue`：移除 `definePageMeta({ ssr: false })`——初识数据加载服务端完成，轮询保持客户端
  - `middleware/admin.ts`：移除 SSR 阶段跳过守卫的逻辑，全部 admin 页面可 SSR
  - 其余页面维持现状（大部分已启用 SSR）
- **登录/退出流程更新**：登录成功时服务端设置 Cookie；退出时清除 Cookie
- **后端（noj-core）配置更新**：添加 CORS `credentials` 支持（如果需要凭证跨域）

## SSR 逐页评估

### 已启用 SSR（无需修改）

| 页面 | 数据获取方式 | 保持 SSR 理由 |
|---|---|---|
| `index.vue` | 静态页面 | SEO 价值，快速首屏 |
| `about.vue` | 静态页面 | 页面内容直接渲染 |
| `login.vue` | 表单提交（客户端） | SSR 无害，布局即内容 |
| `register.vue` | 表单提交（客户端） | 同上 |
| `problems.vue` | `useFetch` + `useAsyncData` | SEO（题目标题可被索引） |
| `problems/[id].vue` | `useFetch` | SEO（题目描述可被索引） |
| `users/[id].vue` | `useFetch` | 可分享 URL，社交预览 |
| `queue.vue` | `usePolling`（客户端） | 保持 SSR→水合空骨架，轮询启动无闪烁 |

### 当前 ssr:false，迁移后可启用 SSR

| 页面 | 当前原因 | 迁移后状态 |
|---|---|---|
| `settings.vue` | 依赖 localStorage auth | ✅ 移除 `ssr: false`，auth SSR 就绪 |
| `submissions/[id].vue` | token 未就绪无法 fetch | ✅ 移除 `ssr: false`，cookie 自动携带 token |
| admin/*（7 页） | 数据高度动态 + 无 SEO 价值 + `$fetch` 直接调用不适合 SSR | ❌ **维持 `ssr: false`**，仅享受 cookie 安全收益 |

> **Admin 维持客户端渲染的理由**：所有 admin 页面使用 `$fetch` + `watch(token)` 模式，SSR 阶段不会执行数据获取；数据（统计/列表/队列）高度实时，SSR 渲染即过时；无 SEO 需求。Cookie 迁移仍带来 HTTP-only 安全收益和 `Authorization` 头自动注入的便利。Admin middleware 保持 `import.meta.server` 跳过逻辑。

## Capabilities

### New Capabilities
- `cookie-auth`: 基于 Cookie 的认证机制，包括 Nitro 代理中的 HTTP-only Cookie 管理、`useCookie` 驱动的客户端状态同步、token 自动注入

### Modified Capabilities
- `user-auth`: JWT token 的传输方式从 `Authorization: Bearer` 客户端直接发送，变为通过 HTTP-only Cookie 由 Nitro 代理自动注入。登录/登出流程增加了服务端 Cookie 的 set/clear 操作

## Impact

- **noj-ui/composables/useAuth.ts** — 核心变更，localStorage → Cookie 迁移
- **noj-ui/server/api/[...slug].ts** — 增强代理逻辑，处理 Cookie → Bearer 注入和登录 Cookie 设置
- **noj-ui/nuxt.config.ts** — 可能需添加 Cookie/SSR 相关配置
- **noj-ui/pages/settings.vue** — 移除 `ssr: false`
- **noj-ui/pages/submissions/[id].vue** — 移除 `ssr: false`
- **noj-ui/middleware/admin.ts** — 移除 SSR 跳过逻辑
- **noj-core/src/app.ts** — CORS 配置更新（支持 credentials）
- **openspec/specs/user-auth/spec.md** — token 传输方式的需求变更
