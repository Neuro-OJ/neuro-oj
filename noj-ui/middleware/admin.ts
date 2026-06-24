/**
 * 管理员路由守卫。
 * 保护所有 `/admin/*` 页面，非管理员用户无法访问。
 *
 * - 未登录 → 重定向到 /login
 * - 非管理员 → 重定向到 /（静默拦截，不给错误提示）
 * - 管理员 → 正常放行
 *
 * 注意：所有 admin 页面使用 ssr: false，服务端不渲染页面内容。
 * 因此在 SSR 阶段跳过守卫，由客户端水合后重新执行。
 */
export default defineNuxtRouteMiddleware(async (_to, _from) => {
  // SSR 阶段跳过守卫——页面是客户端渲染，水合后会重新执行
  if (import.meta.server) return;

  const { loading, isLoggedIn, user } = useAuth();

  // 等待认证状态就绪，加 5s 超时防止后端不可达时页面卡死
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

  // 未登录 → 去登录页
  if (!isLoggedIn.value) {
    return navigateTo("/login");
  }

  // 非管理员 → 重定向首页（不给提示，静默拦截）
  if (user.value?.role !== "admin") {
    return navigateTo("/");
  }
});
