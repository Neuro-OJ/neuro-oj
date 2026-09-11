/**
 * 不需要登录即可访问的路径白名单（issue #49）。
 * 密码重置相关页面（forgot-password / reset-password）必须可匿名访问。
 */
const PUBLIC_AUTH_PATHS = new Set([
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
]);

/**
 * 强制改密路由白名单（issue #75）。
 * must_change_password=true 时仅允许访问这些路径。
 */
const PASSWORD_CHANGE_WHITELIST = new Set<string>([
  '/change-password',
  '/login',
  '/logout',
]);

/**
 * 登录路由守卫。
 * 保护需要登录的页面，未登录用户重定向到 /login。
 *
 * 白名单（issue #49）：/login、/register、/forgot-password、/reset-password 免守卫。
 *
 * SSR 与客户端都会执行：必须先 `await ensureAuthReady()` 拿到真实登录态
 * （SSR 阶段 `useAuth()` 的 `useAsyncData` 尚未 resolve，直接判断会把已登录
 * 用户误判为未登录并 302 到 /login）。
 *
 * issue #75：must_change_password=true 时强制跳到 /change-password，
 * 白名单页面（改密/登录/登出）放行。
 */
export default defineNuxtRouteMiddleware(async (to, _from) => {
  // SSR 阶段仅对 messages 页跳过守卫（该页 ssr:false，水合后重新执行），
  // 避免其他 SSR 页面失去服务端登录保护
  if (import.meta.server && to.path.startsWith('/messages')) return;

  if (PUBLIC_AUTH_PATHS.has(to.path)) return;

  const { isLoggedIn, user, fetchUser, ensureAuthReady } = useAuth();

  // 等待认证状态就绪（SSR 会拉取 /auth/me；客户端由 session cookie 即时恢复）
  await ensureAuthReady();

  if (!isLoggedIn.value) {
    return navigateTo('/login');
  }

  // ── issue #75：session cookie 启动时可能只含基础字段，必须调一次 /me 拿到完整 UserResponse ──
  // 无 created_at/updated_at 视作"未完整初始化"，强制重新拉取
  if (user.value && !user.value.created_at) {
    await fetchUser();
  }

  // must_change_password 强制改密
  if (user.value?.must_change_password === true) {
    const path = to.path;
    if (!PASSWORD_CHANGE_WHITELIST.has(path)) {
      return navigateTo('/change-password');
    }
  }
});
