## Context

### 当前状态

noj-ui 的认证流程完全依赖客户端 `localStorage`：

1. 用户登录 → noj-core 返回 JWT → 存入 `localStorage.setItem("noj:token", token)`
2. 页面加载 → `useAuth` composable 在 `import.meta.client` 中读取 `localStorage`
3. API 请求 → 客户端通过 `$fetch` 的 `headers` 选项手动注入 `Authorization: Bearer <token>`
4. SSR 不可用 → 服务端没有 `localStorage`，3 个页面/全 admin 区域被迫 `ssr: false`

### 约束条件

- noj-core 的认证中间件只接受 `Authorization: Bearer <token>` 头
- noj-core 可能被非浏览器客户端调用（API 客户端、CLI 等），不能强制要求 cookie
- JWT 本身不变，签名和有效期逻辑不变
- Nuxt 3 + Nitro 的 `server/api/` 代理机制是唯一的请求入口

## Goals / Non-Goals

**Goals:**

- 所有 token 操作从 `localStorage` 迁移到 cookie
- JWT token 使用 **HTTP-only** cookie，对客户端 JavaScript 不可见，抵御 XSS token 窃取
- `useAuth` composable 在 SSR 下可用（读取 server-injected 状态而非 localStorage）
- 重新启用 SSR：
  - `pages/settings.vue`
  - `pages/submissions/[id].vue`
  - Admin 全部页面
- Nitro 代理自动完成 Cookie → Bearer 的转换，noj-core 无需改动
- 登录/登出流程完整支持 cookie 的 set/clear

**Non-Goals:**

- 修改 JWT 签发/验证逻辑
- 引入 Refresh Token 机制（维持现有 24h 过期）
- 修改 noj-core 的数据模型或数据库
- 实现社交登录或 OAuth
- 修改 `useProblemFilters`、`usePolling` 等其他 composable

## Decisions

### Decision 1: Cookie → Bearer 转换在 Nitro 代理层完成

**方案**：在 `server/api/[...slug].ts` 中，从请求 cookie 读取 `noj:token`，注入 `Authorization: Bearer <token>` 头后转发给 noj-core。

**理由**：
- noj-core 保持与 Bearer 令牌的兼容性，API 客户端仍可直接用 Bearer 调用
- 所有 cookie 管理集中在代理层，职责清晰
- 无需修改 noj-core 的认证中间件
- 已有现成的 `proxyRequest` 调用，改造代价小

**放弃的方案**：直接修改 noj-core 同时接受 cookie 和 Bearer。理由：增加了后端耦合，且 noj-core 不应关心前端 cookie 的具体实现。

### Decision 2: 双 Cookie 策略

使用两个 cookie，职责分离：

| Cookie 名 | HTTP-only | 路径 | 内容 | 用途 |
|---|---|---|---|---|
| `noj:token` | 是 | `/api` | JWT 字符串 | 服务端认证，JS 不可读 |
| `noj:session` | 否 | `/` | `{ userId, username, role }` JSON | 客户端快速判断登录状态 |

**理由**：
- `noj:token` HTTP-only → 安全，XSS 无法窃取
- `noj:session` 可读 → SSR 时服务端注入用户信息到页面，水合后客户端可直接使用
- 分离职责：token 用于认证，session 用于 UI 状态展示
- `useCookie("noj:session")` 在 SSR 和客户端均可用，是 Nuxt 原生的 SSR-friendly API

### Decision 3: 登录流程改造

```
客户端                          Nitro 代理                        noj-core
  │                               │                                │
  │  POST /api/v1/auth/login      │                                │
  │ ─────────────────────────────►│                                │
  │                               │  POST /api/v1/auth/login       │
  │                               │ ───────────────────────────────►│
  │                               │  { data: { user, token } }     │
  │                               │ ◄───────────────────────────────│
  │                               │                                │
  │                               │  Set-Cookie: noj:token (HTTP-only)
  │                               │  Set-Cookie: noj:session (JSON)
  │                               │  移除 token 字段，只返回 user   │
  │  { data: { user } }           │                                │
  │ ◄─────────────────────────────│                                │
  │                               │                                │
  │  useState("auth:user") = user │                                │
  │  useState("auth:loading") = false
```

### Decision 4: 登出通过 Nitro API 路由清除 Cookie

**方案**：新增 `server/api/auth/logout.post.ts`，清除 `noj:token` 和 `noj:session` cookie。

**理由**：HTTP-only cookie 无法通过客户端 JS 删除，需要服务端响应清除。

### Decision 5: 逐页 SSR 评估

不是所有页面都需要或应该开启 SSR。根据每个页面的数据获取方式和业务场景逐页评估：

#### 已启用 SSR（无需修改）的 8 页

| 页面 | 数据方式 | 为何维持 SSR |
|---|---|---|
| `index.vue` | 纯静态 | SEO 价值，快速首屏 |
| `about.vue` | 纯静态 | 内容页面，直接渲染 |
| `login.vue` | 表单提交（客户端） | SSR 无害，首屏即表单布局 |
| `register.vue` | 表单提交（客户端） | 同上 |
| `problems.vue` | `useFetch` + `useAsyncData` | 题目标题可被搜索引擎索引；筛选/分页 URL 可分享 |
| `problems/[id].vue` | `useFetch` | 题目描述可被索引；Monaco 编辑器用 `<ClientOnly>` 包装，不影响 SSR |
| `users/[id].vue` | `useFetch` | 主页 URL 可在社交平台分享，需要 meta 标签渲染 |
| `queue.vue` | `usePolling`（客户端） | SSR 渲染空骨架→水合后轮询启动，无额外开销 |

> **关于 `queue.vue`**：虽然数据是实时变化的，SSR 渲染初始空状态（`data = null`）然后客户端立刻开始轮询，用户不会看到闪烁。SSR 阶段 `onMounted`/`onUnmounted` 自动不执行，`ref` 响应式正常。

#### 当前 `ssr: false`，迁移后可启用 SSR 的 2 页

| 页面 | ssr:false 原因 | 迁移后收益 | 注意事项 |
|---|---|---|---|
| `settings.vue` | localStorage 无 auth | 避免白屏→闪烁；设置页 SSR 直接渲染表单 |
| `submissions/[id].vue` | token 不可用 | 初始提交数据服务端加载，轮询继续客户端 | 初始 `$fetch` 由 Nitro 代理通过 cookie 自动鉴权 |

#### 维持 `ssr: false` 的 7 页（admin/*）

**Decision: Admin 页面不启用 SSR，保持客户端渲染。**

理由：

1. **无 SEO 价值** — 所有 admin 页面需要登录，搜索引擎不会也不会应该索引
2. **数据高度动态** — 仪表盘统计、提交列表、用户列表频繁变化。SSR 渲染静态快照在用户看到时已过时，水合后立即被覆盖
3. **`$fetch` 调用模式** — admin 页面统一使用 `$fetch` + `watch(token, ...)`，SSR 期间 `watch` 不触发，`$fetch` 也不执行，渲染的只是 loading 态——等于 SSR 白做工
4. **`onMounted` 依赖** — `layouts/admin.vue` 用 `onMounted` 设置窗口 resize 监听（`window.addEventListener`），SSR 下是 no-op，但响应式状态可能不同步
5. **SSR 增加延迟** — 每次刷新 admin 页面，SSR 都要先读 cookie → 调 `/auth/me` 验证 → 再调数据 API — 比直接 SPA 加载多一整轮服务端往返

> Cookie 迁移对 admin 的核心收益是 **安全（HTTP-only 防 XSS token 窃取）** 和 **便利（不再手动注入 Authorization 头）**，而非 SSR。Admin 中间件保持 `if (import.meta.server) return;` 跳过逻辑。

### Decision 6: SSR 时服务端预取用户信息

在 `useAuth` composable 中：

```
SSR 阶段 (import.meta.server):
  - 使用 parseCookies(event) 读取 noj:token
  - 如果有 token，调用 /api/v1/auth/me (通过代理，自动注入 Authorization)
  - 设置 useState("auth:user") 和 useState("auth:loading") = false
  - 设置 useState("auth:token") = token (仅 SSR 内存中用，不暴露给客户端)

Client 水合阶段 (import.meta.client):
  - useState 已有 SSR 注入的值 → 直接使用
  - 若 SSR 未执行（SPA 导航），useState 值保持不变
  - $fetch 调用时由浏览器自动附带 cookie
```

## Risks / Trade-offs

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| Cookie 大小超限（JWT 可能较大） | 请求头膨胀，HTTP 400 | JWT 通常 <2KB，远低于 4KB 限制；监控实际大小 |
| Cookie 跨域问题 | 生产环境若 noj-ui 和 noj-core 不同域 | 当前架构已通过 Nitro 代理同源访问，无跨域 |
| 登出后 cookie 未及时清除 | 用户无法正常登出 | 服务端 logout 端点明确清除；前端同时重置 useState |
| SSR 预取失败导致页面闪烁 | 用户体验下降 | loading 状态管理 + 优雅降级（fetchUser 失败时默认未登录） |
| `noj:session` cookie 未加密 | 用户名等信息明文暴露 | session 仅包含非敏感信息（userId, username, role），不含 token |
