/**
 * 登录路由守卫。
 * 保护需要登录的页面，未登录用户重定向到 /login。
 *
 * SSR 阶段跳过守卫，由客户端水合后重新执行。
 *
 * issue #75：must_change_password=true 时强制跳到 /change-password，
 * 白名单页面（改密/登录/登出）放行。
 */
const PASSWORD_CHANGE_WHITELIST = new Set<string>([
  '/change-password',
  '/login',
  '/logout',
]);

export default defineNuxtRouteMiddleware(async (_to, _from) => {
  if (import.meta.server) return;

  const { loading, isLoggedIn, user, fetchUser } = useAuth();

  if (loading.value) {
    await Promise.race([
      new Promise<void>((resolve) => {
        const unwatch = watch(loading, (val) => {
          if (!val) {
            unwatch();
            resolve();
          }
        });
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  }

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
    const path = _to.path;
    if (!PASSWORD_CHANGE_WHITELIST.has(path)) {
      return navigateTo('/change-password');
    }
  }
});
