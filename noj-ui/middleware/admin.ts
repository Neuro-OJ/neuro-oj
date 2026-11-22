/**
 * 管理员路由守卫。
 * 保护所有 `/admin/*` 页面，非管理员用户无法访问。
 *
 * - 未登录 → 重定向到 /login
 * - 非管理员 → 重定向到 /（静默拦截，不给错误提示）
 * - 管理员 → 正常放行
 *
 * 注意：所有 admin 页面使用 ssr: false，服务端不渲染页面内容，但路由中间件在
 * SSR 阶段仍会执行。因此必须先 `await ensureAuthReady()` 拿到真实登录态
 * （SSR 阶段 `useAuth()` 的 `useAsyncData` 尚未 resolve，直接判断会把已登录
 * 用户误判为未登录并 302 到 /login）。
 */
import { isAdminUser } from '~/utils/isAdminUser';

export default defineNuxtRouteMiddleware(async (_to, _from) => {
  const { isLoggedIn, user, ensureAuthReady } = useAuth();

  // 等待认证状态就绪（SSR 会拉取 /auth/me；客户端由 session cookie 即时恢复）
  await ensureAuthReady();

  // 未登录 → 去登录页
  if (!isLoggedIn.value) {
    return navigateTo('/login');
  }

  // 非管理员 → 重定向首页（不给提示，静默拦截）
  if (!isAdminUser(user.value)) {
    return navigateTo('/');
  }
});
