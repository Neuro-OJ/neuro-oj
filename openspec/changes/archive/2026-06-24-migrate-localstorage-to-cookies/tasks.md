## 1. Nitro 代理增强

- [x] 1.1 修改 `server/api/[...slug].ts`：所有请求转发前从 `noj:token` cookie 读取 token，注入 `Authorization: Bearer <token>` 头
- [x] 1.2 在代理中拦截 `POST /api/v1/auth/login` 的 200 响应：从 `data.token` 中提取 JWT，设置 `Set-Cookie: noj:token`（HTTP-only）和 `Set-Cookie: noj:session`（可读），从响应体移除 `token` 字段

## 2. 登出 API 路由

- [x] 2.1 创建 `server/api/auth/logout.post.ts`：清除 `noj:token` 和 `noj:session` cookie，返回 200

## 3. useAuth composable 重写

- [x] 3.1 移除所有 `localStorage.getItem/setItem/removeItem("noj:token")` 调用
- [x] 3.2 使用 `useCookie("noj:session")` 读取 SSR 注入的 session 信息，替代 localStorage
- [x] 3.3 添加 SSR 阶段的 auth 预取逻辑：在 `import.meta.server` 中从请求头解析 cookie，根据 `noj:token` 调用 `/api/v1/auth/me` 获取用户信息，通过 `useState` 注入页面
- [x] 3.4 更新 `login()` 方法：移除 `localStorage.setItem`，登录成功后直接设置 `useState`
- [x] 3.5 更新 `logout()` 方法：调用 `POST /api/auth/logout`，重置 `useState` 为 null
- [x] 3.6 更新 `fetchUser()` 方法：不再手动注入 `Authorization` 头（由代理自动处理），但调用逻辑不变

## 4. noj-core CORS 配置（如有必要）

- [x] 4.1 检查 `noj-core/src/app.ts` 的 CORS 中间件，确认是否需要添加 `credentials: true` 支持
- [x] 4.2 无需更新 CORS 配置——所有请求通过同源 Nitro 代理转发，无跨域场景

## 5. 重新启用 SSR（非 admin 页面）

- [x] 5.1 `pages/settings.vue`：移除 `definePageMeta({ ssr: false })` + 移除 `token` 依赖、更新 `handleSave` 为 cookie 鉴权
- [x] 5.2 `pages/submissions/[id].vue`：移除 `definePageMeta({ ssr: false })` + `watch(token)`→`watch(isLoggedIn)` + 移除手动 Authorization 头

## 6. 客户端 API 调用中移除手动 Authorization 头

- [x] 6.1 `problems/[id].vue`：移除 `handleSubmit()` 中的 `Authorization: Bearer ${token.value}`（cookie 自动鉴权）
- [x] 6.2 `settings.vue`：移除 `handleSave()` 中的 `Authorization: Bearer ${token.value}`（cookie 自动鉴权）
- [x] 6.3 `problems.vue`：移除 `fetchUserProblemStatus()` 中的 `Authorization: Bearer ${token.value}`（cookie 自动鉴权）
- [x] 6.4 `pages/admin/index.vue`：移除所有 `Authorization: Bearer ${token.value}`（cookie 自动鉴权，页面保持 `ssr: false`）
- [x] 6.5 检查其他 admin 页面（categories.vue, problems.vue, submissions.vue, users.vue, problem-new.vue, problem-edit/[id].vue）中的手动 Authorization 头，移除

## 7. 验证与清理

- [x] 7.1 验证登录流程：代码审查确认——login() 移除 localStorage，Nitro 代理设置 HTTP-only Cookie
- [x] 7.2 验证登出流程：logout 路由清除 Cookie，useAuth 重置状态（代码审查确认）
- [x] 7.3 验证 SSR 渲染：useAuth SSR 初始化逻辑正确读 session cookie
- [x] 7.4 验证 admin 页面保持客户端渲染：admin 页面 `ssr: false` 保留
- [x] 7.5 验证 admin 页面 cookie 鉴权：admin middleware 保持 `import.meta.server` 跳过
- [x] 7.6 验证提交详情页轮询功能：`watch(token)`→`watch(isLoggedIn)`，cookie 自动鉴权
- [x] 7.7 验证设置页面：`ssr: false` 已移除，auth 经由 session cookie SSR 就绪
- [x] 7.8 验证问题详情页提交：手动 Authorization 头已移除
- [x] 7.9 验证用户主页：`useAuth` 无变更影响，用户主页保持 SSR
