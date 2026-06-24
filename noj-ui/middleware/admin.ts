/**
 * 管理员路由守卫。
 * 保护所有 `/admin/*` 页面，非管理员用户无法访问。
 *
 * - 未登录 → 重定向到 /login
 * - 非管理员 → 重定向到 /（静默拦截，不给错误提示）
 * - 管理员 → 正常放行
 */
export default defineNuxtRouteMiddleware(async (_to, _from) => {
  const { loading, isLoggedIn, user } = useAuth();

  // 等待认证状态就绪
  if (loading.value) {
    await new Promise<void>((resolve) => {
      const unwatch = watch(loading, (val) => {
        if (!val) {
          unwatch();
          resolve();
        }
      });
    });
  }

  // 未登录 → 去登录页
  if (!isLoggedIn.value) {
    return navigateTo("/login");
  }

  // 非管理员 → 重定向首页（不给提示，静默拦截）
  if (user.value?.role !== "admin") {
    return navigateTo("/");
  }
});
